import { describe, expect, it } from "vitest";
import { evaluateProvenance, type ObservedEvent, type ObservedInvocation, type RegistryTrace } from "../trace-provenance";

const REG = "CREGISTRY";
const entry: RegistryTrace = { traceId: 9n, agent: "GAGENT", marketId: 3n, action: "Buy", traceHashHex: "ab", ipfsCid: "bafy", publishedAt: 1_700_000_000n };
const event: ObservedEvent = { contractId: REG, traceId: 9n, marketId: 3n, agent: "GAGENT", action: "Buy", traceHashHex: "ab", ipfsCid: "bafy", publishedAt: 1_700_000_000n, txHash: "aa".repeat(32) };
const invocation: ObservedInvocation = { contractId: REG, fn: "publish_trace", agent: "GAGENT", marketId: 3n, action: "Buy", traceHashHex: "ab", ipfsCid: "bafy", returnTraceId: 9n, authorizedBy: ["GAGENT"] };
const tx = { hash: "aa".repeat(32), closeTime: 1_700_000_000, invocation };

describe("evaluateProvenance", () => {
  it("confirms a matching transaction and event", () => {
    expect(evaluateProvenance({ entry, registryId: REG, tx, event }).status).toBe("confirmed");
  });

  it("falls back to confirmed-by-event and outside-retention, never a false confirmed", () => {
    expect(evaluateProvenance({ entry, registryId: REG, tx: null, event }).status).toBe("confirmed-by-event");
    expect(evaluateProvenance({ entry, registryId: REG, tx: null, event: null, outsideRetention: true }).status).toBe("outside-retention");
    expect(evaluateProvenance({ entry, registryId: REG, tx: null, event: null }).status).toBe("unavailable");
  });

  it("flags contradictions and backend disagreements", () => {
    const bad = evaluateProvenance({ entry, registryId: REG, tx: { ...tx, invocation: { ...invocation, authorizedBy: ["GOTHER"] } }, event, claimedTxHash: "bb".repeat(32) });
    expect(bad.status).toBe("contradicted");
    expect(bad.checks.find((c) => c.name === "agent authorized")?.ok).toBe(false);
    expect(bad.disagreements).toContain("backend publishTxHash points at a different transaction");
  });
});
