import type { ResolutionSpec as BackendResolutionSpec } from "@/lib/api/markets";
import type { PriceConfig, SignerConfig } from "./generated/resolver";

/**
 * Fixture vectors for ResolutionSpec ScVal encoding, hashing and canonical question bytes.
 * Authoritative vectors live in oracledesk-stellar contracts repo (mod golden in
 * contracts/resolver/src/lib.rs, golden_legacy_vectors, and scripts/spec-hash) and
 * OracleDesk-Backend (src/utils/hash.util.ts).
 *
 * Vectors that could not be sourced directly from the contracts repository without access
 * are marked as `pending: true` with a TODO naming the exact contracts-repo or backend test.
 */

// Well-known deterministic valid Ed25519 public keys generated from fixed seeds (e.g. 1..32, 2..32)
// Never real keys.
export const VALID_TEST_SIGNER_1 = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
export const VALID_TEST_SIGNER_2 = "GACV2EL42BCB2352AX4IXSV74MG5NEXL775B32635BGL4H6FR73TVF7L";
export const VALID_TEST_SIGNER_3 = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
export const VALID_TEST_REFLECTOR = "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M";

export interface GoldenVector<T> {
  name: string;
  input: T;
  expectedXdrBase64?: string;
  expectedSha256?: string;
  pending: boolean;
  source?: string;
  todo?: string;
}

/**
 * 6 Legacy Signers/Price vectors from contracts/resolver/src/lib.rs (mod golden / golden_legacy_vectors)
 */
export const LEGACY_RESOLUTION_VECTORS: GoldenVector<BackendResolutionSpec | { kind: "signers"; config: SignerConfig } | { kind: "price"; config: PriceConfig }>[] = [
  {
    name: "legacy_signer_single_1_of_1",
    input: {
      kind: "signers",
      signers: [VALID_TEST_SIGNER_1],
      threshold: 1,
      disputeWindow: 86400,
    },
    // Pending contract golden vector:
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::signer_1_of_1",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
  {
    name: "legacy_signer_multi_2_of_3",
    input: {
      kind: "signers",
      signers: [VALID_TEST_SIGNER_1, VALID_TEST_SIGNER_2, VALID_TEST_SIGNER_3],
      threshold: 2,
      disputeWindow: 86400,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::signer_2_of_3",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
  {
    name: "legacy_signer_short_window",
    input: {
      kind: "signers",
      signers: [VALID_TEST_SIGNER_1, VALID_TEST_SIGNER_2],
      threshold: 2,
      disputeWindow: 3600,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::signer_short_window",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
  {
    name: "legacy_price_above",
    input: {
      kind: "price",
      reflector: VALID_TEST_REFLECTOR,
      asset: { kind: "stellar", address: VALID_TEST_REFLECTOR },
      threshold: "6500000000000",
      direction: "Above",
      maxStaleness: 300,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::price_above",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
  {
    name: "legacy_price_below",
    input: {
      kind: "price",
      reflector: VALID_TEST_REFLECTOR,
      asset: { kind: "other", symbol: "BTC" },
      threshold: "100000000000",
      direction: "Below",
      maxStaleness: 60,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::price_below",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
  {
    name: "legacy_price_atorabove",
    input: {
      kind: "price",
      reflector: VALID_TEST_REFLECTOR,
      asset: { kind: "stellar", address: VALID_TEST_REFLECTOR },
      threshold: "50000000",
      direction: "AtOrAbove",
      maxStaleness: 120,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_legacy_vectors::price_atorabove",
    source: "contracts/resolver/src/lib.rs (golden_legacy_vectors)",
  },
];

/**
 * V2 Envelope hash vector
 * Domain tag "oracledesk:resolution-spec" followed by the XDR of
 * ResolutionSpecV2 {version, network_id, market_core, salt, rule}
 */
export const V2_ENVELOPE_VECTORS: GoldenVector<{
  version: number;
  network_id: Buffer;
  market_core: string;
  salt: Buffer;
  rule: BackendResolutionSpec;
}>[] = [
  {
    name: "v2_envelope_signer_spec",
    input: {
      version: 2,
      network_id: Buffer.alloc(32, 1),
      market_core: "CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR",
      salt: Buffer.alloc(32, 0),
      rule: {
        kind: "signers",
        signers: [VALID_TEST_SIGNER_1],
        threshold: 1,
        disputeWindow: 86400,
      },
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_v2_envelope_vectors::v2_spec",
    source: "contracts/resolver/src/lib.rs (scripts/spec-hash)",
  },
];

/**
 * WeightedKeys hash vector
 */
export const WEIGHTED_KEYS_VECTORS: GoldenVector<{
  kind: "weighted_keys";
  dispute_window: bigint;
  signers: { signer: string; weight: number }[];
  weight_threshold: number;
}>[] = [
  {
    name: "weighted_keys_3_signers",
    input: {
      kind: "weighted_keys",
      dispute_window: 86400n,
      signers: [
        { signer: VALID_TEST_SIGNER_1, weight: 10 },
        { signer: VALID_TEST_SIGNER_2, weight: 20 },
        { signer: VALID_TEST_SIGNER_3, weight: 30 },
      ],
      weight_threshold: 40,
    },
    pending: true,
    todo: "Source exact expected XDR and SHA-256 from oracledesk-stellar: contracts/resolver/src/lib.rs::tests::golden_weighted_keys_vectors",
    source: "contracts/resolver/src/lib.rs",
  },
];

/**
 * Canonical Question Bytes Vectors
 * Sourced from backend parity tests (src/utils/hash.util.ts)
 */
export interface CanonicalQuestionVector {
  name: string;
  input: Record<string, unknown>;
  expectedJson: string;
  expectedSha256?: string;
  pending: boolean;
  todo?: string;
  source?: string;
}

export const CANONICAL_QUESTION_VECTORS: CanonicalQuestionVector[] = [
  {
    name: "sorted_keys_and_whitespace",
    input: {
      z_last: 1,
      a_first: "alpha",
      m_mid: true,
    },
    // JSON.stringify with sorted keys, no whitespace
    expectedJson: '{"a_first":"alpha","m_mid":true,"z_last":1}',
    expectedSha256: undefined,
    pending: true,
    todo: "Source exact expected SHA-256 from OracleDesk-Backend: test/utils/hash.util.spec.ts::canonicalBytes::sorted_keys",
    source: "OracleDesk-Backend: src/utils/hash.util.ts",
  },
  {
    name: "unicode_content",
    input: {
      question: "Will ETH reach $5,000 in 2025? 🚀",
      symbol: "ETH/USD",
    },
    expectedJson: '{"question":"Will ETH reach $5,000 in 2025? 🚀","symbol":"ETH/USD"}',
    expectedSha256: undefined,
    pending: true,
    todo: "Source exact expected SHA-256 from OracleDesk-Backend: test/utils/hash.util.spec.ts::canonicalBytes::unicode",
    source: "OracleDesk-Backend: src/utils/hash.util.ts",
  },
  {
    name: "nested_arrays_and_objects",
    input: {
      tags: ["crypto", "defi", "layer1"],
      resolution: {
        source: "coinbase",
        rule: "close_price",
      },
      b: 2,
      a: [
        { y: 2, x: 1 },
        { d: 4, c: 3 },
      ],
    },
    expectedJson: '{"a":[{"x":1,"y":2},{"c":3,"d":4}],"b":2,"resolution":{"rule":"close_price","source":"coinbase"},"tags":["crypto","defi","layer1"]}',
    expectedSha256: undefined,
    pending: true,
    todo: "Source exact expected SHA-256 from OracleDesk-Backend: test/utils/hash.util.spec.ts::canonicalBytes::nested",
    source: "OracleDesk-Backend: src/utils/hash.util.ts",
  },
  {
    name: "escaping_and_numbers",
    input: {
      text: 'Quoted "value" with \\slash and \nnewline',
      num: 12345.678,
      zero: 0,
      neg: -42,
    },
    expectedJson: '{"neg":-42,"num":12345.678,"text":"Quoted \\"value\\" with \\\\slash and \\nnewline","zero":0}',
    expectedSha256: undefined,
    pending: true,
    todo: "Source exact expected SHA-256 from OracleDesk-Backend: test/utils/hash.util.spec.ts::canonicalBytes::escaping",
    source: "OracleDesk-Backend: src/utils/hash.util.ts",
  },
];
