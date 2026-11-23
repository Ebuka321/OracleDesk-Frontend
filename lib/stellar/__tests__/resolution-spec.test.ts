import { describe, expect, it } from "vitest";
import {
  buildPriceConfigScVal,
  buildSignerConfigScVal,
  computeResolutionHash,
  formatResolutionSpec,
  resolutionSpecToScVal,
  verifyResolutionCommitment,
} from "../resolution-spec";
import type { ResolutionSpec } from "@/lib/api/markets";
import {
  VALID_TEST_SIGNER_1,
  VALID_TEST_SIGNER_2,
  VALID_TEST_SIGNER_3,
  VALID_TEST_REFLECTOR,
  LEGACY_RESOLUTION_VECTORS,
  V2_ENVELOPE_VECTORS,
  WEIGHTED_KEYS_VECTORS,
  CANONICAL_QUESTION_VECTORS,
} from "./resolution-vectors.fixtures";
import { canonicalBytes, questionHash } from "../market-create";

describe("ResolutionSpec XDR encoding & Cross-Repo Vectors", () => {
  // Deterministic valid test strkeys generated from fixed seeds
  const signerAddress = VALID_TEST_SIGNER_1;
  const reflectorAddress = VALID_TEST_REFLECTOR;

  // Signers rule (1 of 1, 24h dispute window)
  const signerSpec: ResolutionSpec = {
    kind: "signers",
    signers: [signerAddress],
    threshold: 1,
    disputeWindow: 86400,
  };

  // Price rule (Reflector Above 650,000.0000000 USDC, 300s staleness)
  const priceSpec: ResolutionSpec = {
    kind: "price",
    reflector: reflectorAddress,
    asset: { kind: "stellar", address: reflectorAddress },
    threshold: "6500000000000",
    direction: "Above",
    maxStaleness: 300,
  };

  it("encodes Signers spec to canonical Soroban ScVal vector", () => {
    const scVal = resolutionSpecToScVal(signerSpec);
    expect(scVal.switch().name).toBe("scvVec");
    const vec = scVal.vec();
    expect(vec).toBeDefined();
    expect(vec?.[0].sym().toString()).toBe("Signers");

    // Inner config is a Map
    const configMap = vec?.[1].map();
    expect(configMap).toBeDefined();
    expect(configMap?.length).toBe(3);

    // Sorted keys: dispute_window, signers, threshold
    expect(configMap?.[0].key().sym().toString()).toBe("dispute_window");
    expect(configMap?.[1].key().sym().toString()).toBe("signers");
    expect(configMap?.[2].key().sym().toString()).toBe("threshold");
  });

  it("encodes Price spec to canonical Soroban ScVal vector", () => {
    const scVal = resolutionSpecToScVal(priceSpec);
    expect(scVal.switch().name).toBe("scvVec");
    const vec = scVal.vec();
    expect(vec).toBeDefined();
    expect(vec?.[0].sym().toString()).toBe("Price");

    // Inner config is a Map with 5 sorted keys
    const configMap = vec?.[1].map();
    expect(configMap).toBeDefined();
    expect(configMap?.length).toBe(5);

    expect(configMap?.[0].key().sym().toString()).toBe("asset");
    expect(configMap?.[1].key().sym().toString()).toBe("direction");
    expect(configMap?.[2].key().sym().toString()).toBe("max_staleness");
    expect(configMap?.[3].key().sym().toString()).toBe("reflector");
    expect(configMap?.[4].key().sym().toString()).toBe("threshold");
  });

  it("computes deterministic SHA-256 hash for golden Signers vector", async () => {
    const hash = await computeResolutionHash(signerSpec);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Recomputing produces identical hash
    const hashAgain = await computeResolutionHash(signerSpec);
    expect(hash).toBe(hashAgain);
  });

  it("computes deterministic SHA-256 hash for golden Price vector", async () => {
    const hash = await computeResolutionHash(priceSpec);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const hashAgain = await computeResolutionHash(priceSpec);
    expect(hash).toBe(hashAgain);
  });

  it("detects modification of any spec field as hash mismatch", async () => {
    const baseHash = await computeResolutionHash(signerSpec);

    // Changing threshold from 1 to 2
    const tamperedThreshold: ResolutionSpec = { ...signerSpec, threshold: 2 };
    const tamperedHash1 = await computeResolutionHash(tamperedThreshold);
    expect(tamperedHash1).not.toBe(baseHash);

    // Changing dispute window from 86400 to 3600
    const tamperedWindow: ResolutionSpec = { ...signerSpec, disputeWindow: 3600 };
    const tamperedHash2 = await computeResolutionHash(tamperedWindow);
    expect(tamperedHash2).not.toBe(baseHash);

    // Changing signer key
    const differentSigner = VALID_TEST_SIGNER_2;
    const tamperedSigner: ResolutionSpec = { ...signerSpec, signers: [differentSigner] };
    const tamperedHash3 = await computeResolutionHash(tamperedSigner);
    expect(tamperedHash3).not.toBe(baseHash);
  });

  it("preserves signer order: order matters and swapping signers changes the hash", async () => {
    const specOrder1: ResolutionSpec = {
      kind: "signers",
      signers: [VALID_TEST_SIGNER_1, VALID_TEST_SIGNER_2],
      threshold: 2,
      disputeWindow: 86400,
    };
    const specOrder2: ResolutionSpec = {
      kind: "signers",
      signers: [VALID_TEST_SIGNER_2, VALID_TEST_SIGNER_1],
      threshold: 2,
      disputeWindow: 86400,
    };

    const hash1 = await computeResolutionHash(specOrder1);
    const hash2 = await computeResolutionHash(specOrder2);
    expect(hash1).not.toBe(hash2);
  });

  describe("Contract Cross-Repo Vectors (fixtures/resolution-vectors.fixtures.ts)", () => {
    LEGACY_RESOLUTION_VECTORS.forEach((vector) => {
      if (vector.pending) {
        it.skip(`[PENDING CONTRACT VECTOR] ${vector.name}: ${vector.todo}`, () => {
          // Awaiting authoritative byte-exact XDR & SHA-256 from contracts repo:
          // ${vector.source}
          expect(vector.expectedSha256).toBeDefined();
        });
      } else {
        it(`matches contracts repo golden vector: ${vector.name}`, async () => {
          const scVal = resolutionSpecToScVal(vector.input);
          if (vector.expectedXdrBase64) {
            expect(scVal.toXDR("base64")).toBe(vector.expectedXdrBase64);
          }
          if (vector.expectedSha256) {
            const hash = await computeResolutionHash(vector.input);
            expect(hash).toBe(vector.expectedSha256);
          }
        });
      }
    });

    V2_ENVELOPE_VECTORS.forEach((vector) => {
      if (vector.pending) {
        it.skip(`[PENDING V2 VECTOR] ${vector.name}: ${vector.todo}`, () => {
          expect(vector.expectedSha256).toBeDefined();
        });
      }
    });

    WEIGHTED_KEYS_VECTORS.forEach((vector) => {
      if (vector.pending) {
        it.skip(`[PENDING WEIGHTED KEYS VECTOR] ${vector.name}: ${vector.todo}`, () => {
          expect(vector.expectedSha256).toBeDefined();
        });
      }
    });
  });

  describe("Canonical Question Bytes Vectors (market-create)", () => {
    CANONICAL_QUESTION_VECTORS.forEach((vector) => {
      it(`canonicalizes question correctly: ${vector.name}`, () => {
        const bytes = canonicalBytes(vector.input);
        const jsonStr = new TextDecoder().decode(bytes);
        expect(jsonStr).toBe(vector.expectedJson);
      });

      if (vector.pending) {
        it.skip(`[PENDING BACKEND SHA256] ${vector.name}: ${vector.todo}`, () => {
          expect(vector.expectedSha256).toBeDefined();
        });
      } else {
        it(`matches backend questionHash: ${vector.name}`, async () => {
          const hash = await questionHash(vector.input);
          expect(hash).toBe(vector.expectedSha256);
        });
      }
    });
  });
});

describe("verifyResolutionCommitment", () => {
  const signerAddress = VALID_TEST_SIGNER_1;
  const validSpec: ResolutionSpec = {
    kind: "signers",
    signers: [signerAddress],
    threshold: 1,
    disputeWindow: 86400,
  };

  it("verifies matching revealed spec against on-chain commitment", async () => {
    const commitmentHash = await computeResolutionHash(validSpec);
    const res = await verifyResolutionCommitment(validSpec, commitmentHash);

    expect(res.status).toBe("verified");
    expect(res.computedHash).toBe(commitmentHash);
    expect(res.onChainHash).toBe(commitmentHash);
    expect(res.formattedSpec).toContain("1 of 1 signers");
    expect(res.formattedSpec).toContain("24h dispute window");
  });

  it("reports mismatch when backend spec differs from on-chain commitment", async () => {
    const realOnChainHash = await computeResolutionHash(validSpec);

    // Backend claims 2 of 3 signers while chain committed to 1 of 1
    const misleadingBackendSpec: ResolutionSpec = {
      kind: "signers",
      signers: [
        signerAddress,
        VALID_TEST_SIGNER_2,
        VALID_TEST_SIGNER_3,
      ],
      threshold: 2,
      disputeWindow: 86400,
    };

    const res = await verifyResolutionCommitment(misleadingBackendSpec, realOnChainHash);
    expect(res.status).toBe("mismatch");
    expect(res.reason).toMatch(/SpecHashMismatch/i);
    expect(res.computedHash).not.toBe(realOnChainHash);
  });

  it("reports unsupported for advanced resolver rules instead of false mismatch", async () => {
    const dummyHash = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

    const weightedSpec = {
      kind: "WeightedKeys",
      signers: [{ signer: VALID_TEST_SIGNER_1, weight: 1 }],
      weight_threshold: 1,
    };
    const resWeighted = await verifyResolutionCommitment(weightedSpec as any, dummyHash);
    expect(resWeighted.status).toBe("unsupported");
    expect(resWeighted.reason).toContain("not yet supported");

    const committeeSpec = {
      kind: "Committee",
      committeeId: 1,
    };
    const resCommittee = await verifyResolutionCommitment(committeeSpec as any, dummyHash);
    expect(resCommittee.status).toBe("unsupported");

    const hybridSpec = {
      kind: "Hybrid",
    };
    const resHybrid = await verifyResolutionCommitment(hybridSpec as any, dummyHash);
    expect(resHybrid.status).toBe("unsupported");
  });

  it("handles unconfigured and no-spec states gracefully", async () => {
    const unconfigured = await verifyResolutionCommitment(validSpec, Buffer.alloc(32));
    expect(unconfigured.status).toBe("unconfigured");

    const noSpec = await verifyResolutionCommitment(null, "abcdef".repeat(10) + "1234");
    expect(noSpec.status).toBe("no-spec");
  });
});

describe("formatResolutionSpec", () => {
  it("formats signer specs in plain words", () => {
    const text1 = formatResolutionSpec({
      kind: "signers",
      signers: [VALID_TEST_SIGNER_1],
      threshold: 1,
      disputeWindow: 86400,
    });
    expect(text1).toContain("1 of 1 signers");
    expect(text1).toContain("24h dispute window");

    const text2 = formatResolutionSpec({
      kind: "signers",
      signers: [
        VALID_TEST_SIGNER_1,
        VALID_TEST_SIGNER_2,
      ],
      threshold: 2,
      disputeWindow: 43200,
    });
    expect(text2).toContain("2 of 2 signers");
    expect(text2).toContain("12h dispute window");
  });

  it("formats price specs in plain words", () => {
    const text = formatResolutionSpec({
      kind: "price",
      reflector: VALID_TEST_REFLECTOR,
      asset: { kind: "stellar", address: VALID_TEST_REFLECTOR },
      threshold: "100000000",
      direction: "Above",
      maxStaleness: 60,
    });
    expect(text).toContain("Reflector feed");
    expect(text).toContain("Above");
    expect(text).toContain("60s max staleness");
  });

  it("formats unsupported specs cleanly", () => {
    const text = formatResolutionSpec({
      kind: "Committee",
    } as any);
    expect(text).toContain("Specialized resolution rule (Committee)");
  });

  it("handles empty spec cleanly", () => {
    expect(formatResolutionSpec(null)).toBe("No revealed resolution spec");
    expect(formatResolutionSpec(undefined)).toBe("No revealed resolution spec");
  });
});
