import { describe, expect, it } from "vitest";
import {
  CLOSE_GRACE_MS,
  PRICE_TOLERANCE_BPS,
  buildDbSnapshot,
  classifyDrift,
  type DbSnapshot,
} from "../drift";
import type { Market as ChainMarket, MarketStatus } from "@/lib/stellar/generated/market-core";
import type { Market as BackendMarket } from "@/lib/api/markets";

const NOW = new Date("2026-10-18T12:00:00Z");
const CLOSE = Math.floor(NOW.getTime() / 1_000) - 3_600;

const open: MarketStatus = { tag: "Open", values: undefined };
const resolvedYes: MarketStatus = { tag: "Resolved", values: [{ tag: "Yes", values: undefined }] };
const voided: MarketStatus = { tag: "Void", values: undefined };

function chainMarket(over: Record<string, unknown> = {}, status: MarketStatus = open): ChainMarket {
  return {
    close_time: BigInt(CLOSE),
    reserve_yes: 500n,
    reserve_no: 500n,
    question_hash: Buffer.alloc(32, 1),
    resolution_hash: Buffer.alloc(32, 2),
    meta_uri: "ipfs://q",
    status,
    ...over,
  } as unknown as ChainMarket;
}

function row(over: Partial<DbSnapshot> = {}): DbSnapshot {
  return {
    status: "ACTIVE",
    currentYesProb: 0.5,
    expiryTimestamp: new Date(CLOSE * 1_000).toISOString(),
    questionHash: Buffer.alloc(32, 1).toString("hex"),
    resolutionHash: Buffer.alloc(32, 2).toString("hex"),
    metaUri: "ipfs://q",
    ...over,
  };
}

const classes = (findings: { driftClass: string }[]) => findings.map((finding) => finding.driftClass).sort();

describe("classifyDrift", () => {
  it("honours the close grace window", () => {
    expect(CLOSE_GRACE_MS).toBe(60_000);
    expect(classes(classifyDrift(row(), chainMarket(), (CLOSE + 30) * 1_000))).toEqual([]);
    expect(classes(classifyDrift(row(), chainMarket(), NOW.getTime()))).toEqual(["CLOSED_BUT_ACTIVE"]);
    expect(classes(classifyDrift(row({ status: "RESOLVING" }), chainMarket(), NOW.getTime()))).toEqual([]);
  });

  it("mirrors backend status transition classes", () => {
    expect(classes(classifyDrift(row(), chainMarket({}, resolvedYes), NOW.getTime()))).toEqual(["MISSED_RESOLUTION"]);
    expect(classes(classifyDrift(row(), chainMarket({}, voided), NOW.getTime()))).toEqual(["MISSED_VOID"]);
    expect(classes(classifyDrift(row({ status: "RESOLVED" }), chainMarket({}, resolvedYes), NOW.getTime()))).toEqual([]);
    expect(classes(classifyDrift(row({ status: "CANCELLED" }), chainMarket({}, voided), NOW.getTime()))).toEqual([]);
    expect(classes(classifyDrift(row({ status: "RESOLVED" }), chainMarket(), NOW.getTime()))).toEqual(["STATUS_REGRESSION"]);
    expect(classes(classifyDrift(row({ status: "CANCELLED" }), chainMarket({}, resolvedYes), NOW.getTime()))).toEqual(["STATUS_REGRESSION"]);
  });

  it("compares prices in integer basis points", () => {
    expect(PRICE_TOLERANCE_BPS).toBe(50);
    expect(classes(classifyDrift(row({ status: "RESOLVING", currentYesProb: 0.6 }), chainMarket(), NOW.getTime()))).toEqual(["PRICE_STALE"]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", currentYesProb: 0.504 }), chainMarket(), NOW.getTime()))).toEqual([]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", currentYesProb: 0.505 }), chainMarket(), NOW.getTime()))).toEqual([]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", currentYesProb: 0.5051 }), chainMarket(), NOW.getTime()))).toEqual(["PRICE_STALE"]);
  });

  it("detects close time and hash drift and ignores unset columns", () => {
    expect(classes(classifyDrift(row({ status: "RESOLVING", expiryTimestamp: new Date((CLOSE + 99) * 1_000).toISOString() }), chainMarket(), NOW.getTime()))).toEqual(["CLOSE_TIME_MISMATCH"]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", questionHash: "aa".repeat(32) }), chainMarket(), NOW.getTime()))).toEqual(["HASH_MISMATCH"]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", metaUri: "ipfs://other" }), chainMarket(), NOW.getTime()))).toEqual(["HASH_MISMATCH"]);
    expect(classes(classifyDrift(row({ status: "RESOLVING", questionHash: null, resolutionHash: null, metaUri: null }), chainMarket(), NOW.getTime()))).toEqual([]);
  });

  it("reports a missing chain market", () => {
    expect(classes(classifyDrift(row(), null, NOW.getTime()))).toEqual(["NOT_FOUND_ON_CHAIN"]);
  });
});

describe("buildDbSnapshot", () => {
  it("overlays finding values on the backend market", () => {
    const market = {
      status: "ACTIVE",
      currentYesProb: 0.5,
      expiryTimestamp: new Date(CLOSE * 1_000).toISOString(),
      questionHash: "aa".repeat(32),
      resolutionHash: null,
      metaUri: "ipfs://q",
    } as BackendMarket;
    const snapshot = buildDbSnapshot(market, {
      status: "RESOLVED",
      currentYesProb: 0.72,
      expiryTimestamp: CLOSE + 10,
      resolutionHash: "bb".repeat(32),
    });
    expect(snapshot.status).toBe("RESOLVED");
    expect(snapshot.currentYesProb).toBe(0.72);
    expect(snapshot.expiryTimestamp).toBe(new Date((CLOSE + 10) * 1_000).toISOString());
    expect(snapshot.questionHash).toBe("aa".repeat(32));
    expect(snapshot.resolutionHash).toBe("bb".repeat(32));
  });
});
