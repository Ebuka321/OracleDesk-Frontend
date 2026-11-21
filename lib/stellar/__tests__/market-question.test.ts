import { describe, expect, it, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import {
  clearQuestionCheckCache,
  formatHashHex,
  getCachedQuestionCheck,
  isZeroOrEmptyHash,
  setCachedQuestionCheck,
  verifyMarketQuestion,
} from "../market-question";
import {
  parseQuestionDocument,
  sanitizeText,
  sanitizeUrl,
} from "../question-parser";

describe("isZeroOrEmptyHash & formatHashHex", () => {
  it("recognizes empty and all-zero hashes", () => {
    expect(isZeroOrEmptyHash(null)).toBe(true);
    expect(isZeroOrEmptyHash(undefined)).toBe(true);
    expect(isZeroOrEmptyHash("")).toBe(true);
    expect(isZeroOrEmptyHash(Buffer.alloc(0))).toBe(true);
    expect(isZeroOrEmptyHash(Buffer.alloc(32))).toBe(true);
    expect(isZeroOrEmptyHash("0000000000000000000000000000000000000000000000000000000000000000")).toBe(true);
    expect(isZeroOrEmptyHash("0x" + "0".repeat(64))).toBe(true);
  });

  it("recognizes valid non-zero hashes", () => {
    const valid = Buffer.alloc(32, 1);
    expect(isZeroOrEmptyHash(valid)).toBe(false);
    expect(formatHashHex(valid)).toBe("01".repeat(32));
    expect(formatHashHex("0xabcdef1234")).toBe("abcdef1234");
  });
});

describe("sanitizeText and sanitizeUrl (Hostile String Handling)", () => {
  it("strips ASCII control characters", () => {
    const hostile = "Hello\x00\x07\x1F World\x7F!";
    expect(sanitizeText(hostile)).toBe("Hello World!");
  });

  it("strips Unicode bidirectional override characters", () => {
    // \u202E is RLO, \u202A is LRE, \u202C is PDF
    const bidiHostile = "Will BTC \u202Eclose above $100k\u202C?";
    expect(sanitizeText(bidiHostile)).toBe("Will BTC close above $100k?");
  });

  it("accepts only http: and https: URLs and extracts host", () => {
    expect(sanitizeUrl("https://api.coingecko.com/btc")).toEqual({
      safeUrl: "https://api.coingecko.com/btc",
      host: "api.coingecko.com",
    });
    expect(sanitizeUrl("http://example.com")).toEqual({
      safeUrl: "http://example.com/",
      host: "example.com",
    });
  });

  it("rejects hostile URL schemes (javascript:, data:, vbscript:)", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("parseQuestionDocument (Schemas & Robustness)", () => {
  it("parses Shape (a) v2 pinned by createMarketOnChain with resolution block", () => {
    const raw = {
      version: 2,
      question: "Will ETH reach $5000 by end of year?",
      category: "Crypto",
      contractCategory: 1,
      closeTime: 1735689600,
      resolutionSource: "Coingecko",
      resolutionHash: "a".repeat(64),
      resolution: {
        sourceId: "coingecko-eth",
        url: "https://coingecko.com/en/coins/ethereum",
        measurable: "ETH/USD spot price",
        comparator: ">=",
        threshold: "5000",
        deadlineUtc: "2025-12-31T23:59:59Z",
        instructions: "Check 24h close on Coingecko",
      },
      priceResolution: {
        oracle: "band",
        asset: "ETH",
        threshold: "5000000000",
      },
    };

    const res = parseQuestionDocument(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.schemaType).toBe("market-create-v2");
      expect(res.doc.question).toBe(raw.question);
      expect(res.doc.resolution?.measurable).toBe("ETH/USD spot price");
      expect(res.doc.resolution?.safeUrl).toBe("https://coingecko.com/en/coins/ethereum");
      expect(res.doc.resolution?.urlHost).toBe("coingecko.com");
      expect(res.doc.priceResolution?.oracle).toBe("band");
    }
  });

  it("parses Shape (b) QuestionDocV2 (strict)", () => {
    const raw = {
      schemaVersion: 2,
      kind: "oracledesk.question",
      question: "Will SpaceX launch Starship Flight 8 in Q1 2025?",
      category: "Tech",
      closeTime: 1743465600,
      resolutionSpecHash: "b".repeat(64),
      resolution: {
        sourceId: "spacex-official",
        url: "https://spacex.com/launches",
        measurable: "Starship orbital launch attempt",
        comparator: "==",
        threshold: "true",
        deadlineUtc: "2025-03-31T23:59:59Z",
      },
    };

    const res = parseQuestionDocument(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.schemaType).toBe("question-doc-v2");
      expect(res.doc.resolutionHash).toBe("b".repeat(64));
    }
  });

  it("parses Shape (c) strict v1 schema", () => {
    const raw = {
      version: 1,
      question: "Will the Fed cut rates in March?",
      category: "Economy",
      closeTime: 1742000000,
      resolutionSource: "federalreserve.gov",
    };

    const res = parseQuestionDocument(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.schemaType).toBe("market-create-v1");
      expect(res.doc.resolution).toBeNull();
    }
  });

  it("accepts plain-text document as plain-text schema with no structured terms", () => {
    const text = "Will BTC reach $100k before 2026?";
    const res = parseQuestionDocument(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.doc.schemaType).toBe("plain-text");
      expect(res.doc.isPlainText).toBe(true);
      expect(res.doc.resolution).toBeNull();
    }
  });

  it("rejects unknown document version with clear error", () => {
    const unknownVersion = {
      version: 99,
      question: "Test question",
      category: "Crypto",
    };
    const res = parseQuestionDocument(unknownVersion);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("unsupported_version");
      expect(res.reason).toMatch(/Unsupported document version/i);
    }
  });

  it("rejects document missing required question string", () => {
    const missing = { version: 1, category: "Crypto" };
    const res = parseQuestionDocument(missing);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("invalid_fields");
    }
  });
});

describe("verifyMarketQuestion (Integration & Trust Rules)", () => {
  beforeEach(() => {
    clearQuestionCheckCache();
  });

  const question = "Will BTC close above $100k on 31 Dec?";
  const doc = {
    version: 2,
    question,
    category: "Crypto",
    closeTime: 1735689600,
    resolutionHash: "f".repeat(64),
    resolution: {
      sourceId: "coingecko",
      url: "https://coingecko.com",
      measurable: "BTC Price",
      comparator: ">=",
      threshold: "100000",
      deadlineUtc: "2024-12-31T23:59:59Z",
    },
  };
  const rawBytes = new TextEncoder().encode(JSON.stringify(doc));
  const validHash = createHash("sha256").update(rawBytes).digest("hex");

  const mockFetch = (text: string, status = 200) =>
    (async () => new Response(text, { status })) as typeof fetch;

  it("returns verified when document matches on-chain commitment", async () => {
    const res = await verifyMarketQuestion({
      displayedQuestion: question,
      metaUri: "ipfs://bafyvalid",
      questionHash: validHash,
      fetchImpl: mockFetch(JSON.stringify(doc)),
      hasChainRead: true,
      chainMarket: {
        close_time: 1735689600n,
        category: "Crypto",
        resolution_hash: Buffer.from("f".repeat(64), "hex"),
      },
    });

    expect(res.status).toBe("verified");
    expect(res.committedQuestion).toBe(question);
    expect(res.committedHash).toBe(validHash);
    expect(res.parsedDoc?.resolution?.measurable).toBe("BTC Price");
    expect(res.mismatches).toBeUndefined();
  });

  it("trust bug fix: returns unavailable when chain read is missing (hasChainRead: false)", async () => {
    const res = await verifyMarketQuestion({
      displayedQuestion: question,
      metaUri: "ipfs://bafyvalid",
      questionHash: validHash,
      fetchImpl: mockFetch(JSON.stringify(doc)),
      hasChainRead: false, // Chain read is missing
    });

    expect(res.status).toBe("unavailable");
    expect(res.reason).toMatch(/On-chain state unavailable/i);
    expect(res.chainChecked).toBe(false);
  });

  it("detects cross-check disagreements with chain state (close time, category, res hash)", async () => {
    const res = await verifyMarketQuestion({
      displayedQuestion: "Different displayed title from backend",
      metaUri: "ipfs://bafyvalid",
      questionHash: validHash,
      fetchImpl: mockFetch(JSON.stringify(doc)),
      hasChainRead: true,
      chainMarket: {
        close_time: 1700000000n, // Different close time
        category: "Finance", // Different category
        resolution_hash: Buffer.from("0".repeat(64), "hex"), // Different res hash
      },
    });

    expect(res.status).toBe("verified");
    expect(res.mismatches).toBeDefined();
    expect(res.mismatches?.questionMismatch).toBeDefined();
    expect(res.mismatches?.closeTimeMismatch).toBeDefined();
    expect(res.mismatches?.categoryMismatch).toBeDefined();
    expect(res.mismatches?.resolutionHashMismatch).toBeDefined();
  });

  it("caches only verified results keyed strictly by committedHash", async () => {
    expect(getCachedQuestionCheck(validHash)).toBeUndefined();

    // Verify
    await verifyMarketQuestion({
      displayedQuestion: question,
      metaUri: "ipfs://bafyvalid",
      questionHash: validHash,
      fetchImpl: mockFetch(JSON.stringify(doc)),
      hasChainRead: true,
    });

    const cached = getCachedQuestionCheck(validHash);
    expect(cached).toBeDefined();
    expect(cached?.status).toBe("verified");

    // Attempting to set an unverified result in cache is rejected
    setCachedQuestionCheck("unverified-hash", {
      status: "unavailable",
      displayedQuestion: "Unverified",
      committedQuestion: null,
      committedHash: "unverified-hash",
      computedHash: null,
      chainChecked: false,
    });
    expect(getCachedQuestionCheck("unverified-hash")).toBeUndefined();
  });
});
