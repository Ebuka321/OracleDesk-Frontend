import { priceYesBps } from "@/lib/stellar/generated/fpmm";
import type { Market, MarketStatus as BackendStatus } from "@/lib/api/markets";
import type { Market as ChainMarket } from "@/lib/stellar/generated/market-core";

export const DRIFT_CLASSES = [
  "MISSED_RESOLUTION",
  "MISSED_VOID",
  "CLOSED_BUT_ACTIVE",
  "PRICE_STALE",
  "CLOSE_TIME_MISMATCH",
  "HASH_MISMATCH",
  "NOT_FOUND_ON_CHAIN",
  "STATUS_REGRESSION",
] as const;

export type DriftClass = (typeof DRIFT_CLASSES)[number];

export const DRIFT_ACTIONS = ["REPAIRED", "REPORTED", "DEFERRED", "SKIPPED_NEWER"] as const;

export type DriftAction = (typeof DRIFT_ACTIONS)[number];

export const RESOLUTION_CLASSES = new Set<DriftClass>([
  "MISSED_RESOLUTION",
  "MISSED_VOID",
  "CLOSED_BUT_ACTIVE",
]);

export const INTEGRITY_CLASSES = new Set<DriftClass>([
  "HASH_MISMATCH",
  "STATUS_REGRESSION",
  "NOT_FOUND_ON_CHAIN",
]);

export const CLOSE_GRACE_MS = 60_000;
export const PRICE_TOLERANCE_BPS = 50;

const FINAL = new Set<BackendStatus>(["RESOLVED", "CANCELLED"]);

export type DriftClassification = Pick<DriftFinding, "driftClass" | "dbValue" | "chainValue">;

export interface DriftFinding {
  id?: string;
  runId: string;
  marketId: string;
  onChainMarketId: string;
  driftClass: DriftClass | string;
  dbValue: unknown;
  chainValue: unknown;
  action: DriftAction | string;
  observedLedger: number;
  createdAt?: string;
}

export interface DbSnapshot {
  status: BackendStatus;
  currentYesProb: number | null;
  expiryTimestamp: string;
  questionHash: string | null;
  resolutionHash: string | null;
  metaUri: string | null;
}

type MarketSnapshot = Pick<
  Market,
  "status" | "currentYesProb" | "expiryTimestamp" | "questionHash" | "resolutionHash" | "metaUri"
>;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

export function buildDbSnapshot(market: MarketSnapshot, dbValue: unknown): DbSnapshot {
  const raw = asObject(dbValue);
  const expiry = raw.expiryTimestamp;
  return {
    status: typeof raw.status === "string" ? (raw.status as BackendStatus) : market.status,
    currentYesProb: typeof raw.currentYesProb === "number" ? raw.currentYesProb : market.currentYesProb,
    expiryTimestamp:
      typeof expiry === "number"
        ? new Date(expiry * 1000).toISOString()
        : typeof expiry === "string"
          ? expiry
          : market.expiryTimestamp,
    questionHash: optionalString(raw.questionHash) ?? market.questionHash,
    resolutionHash: optionalString(raw.resolutionHash) ?? market.resolutionHash,
    metaUri: optionalString(raw.metaUri) ?? market.metaUri,
  };
}

function hashToHex(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return "";
}

export function classifyDrift(
  row: DbSnapshot,
  chain: ChainMarket | null,
  ledgerTimeMs: number,
): DriftClassification[] {
  if (!chain) {
    return [
      {
        driftClass: "NOT_FOUND_ON_CHAIN",
        dbValue: { status: row.status },
        chainValue: null,
      },
    ];
  }

  const findings: DriftClassification[] = [];
  const status = chain.status;
  const dbFinal = FINAL.has(row.status);

  if (status.tag === "Resolved") {
    const outcome = status.values[0]?.tag ?? "Unknown";
    if (!dbFinal) {
      findings.push({ driftClass: "MISSED_RESOLUTION", dbValue: { status: row.status }, chainValue: { status: "Resolved", outcome } });
    } else if (row.status !== "RESOLVED") {
      findings.push({ driftClass: "STATUS_REGRESSION", dbValue: { status: row.status }, chainValue: { status: "Resolved", outcome } });
    }
  } else if (status.tag === "Void") {
    if (!dbFinal) {
      findings.push({ driftClass: "MISSED_VOID", dbValue: { status: row.status }, chainValue: { status: "Void" } });
    } else if (row.status !== "CANCELLED") {
      findings.push({ driftClass: "STATUS_REGRESSION", dbValue: { status: row.status }, chainValue: { status: "Void" } });
    }
  } else if (dbFinal) {
    findings.push({ driftClass: "STATUS_REGRESSION", dbValue: { status: row.status }, chainValue: { status: "Open" } });
  } else {
    if (
      row.status === "ACTIVE" &&
      Number(chain.close_time) * 1000 + CLOSE_GRACE_MS <= ledgerTimeMs
    ) {
      findings.push({
        driftClass: "CLOSED_BUT_ACTIVE",
        dbValue: { status: row.status },
        chainValue: { status: "Open", closeTime: Number(chain.close_time), ledgerTime: new Date(ledgerTimeMs).toISOString() },
      });
    }
    const chainBps = Number(priceYesBps(chain.reserve_yes, chain.reserve_no));
    const dbBps = row.currentYesProb === null ? Number.NaN : Math.round(row.currentYesProb * 10_000);
    if (!Number.isFinite(dbBps) || Math.abs(chainBps - dbBps) > PRICE_TOLERANCE_BPS) {
      findings.push({
        driftClass: "PRICE_STALE",
        dbValue: { currentYesProb: row.currentYesProb },
        chainValue: { currentYesProb: chainBps / 10_000 },
      });
    }
  }

  const expiry = Math.floor(Date.parse(row.expiryTimestamp) / 1000);
  if (Number(chain.close_time) !== expiry) {
    findings.push({
      driftClass: "CLOSE_TIME_MISMATCH",
      dbValue: { expiryTimestamp: expiry },
      chainValue: { closeTime: Number(chain.close_time) },
    });
  }

  const db: Record<string, string> = {};
  const onChain: Record<string, string> = {};
  const compare = (field: string, rowValue: string | null, chainValue: string) => {
    if (rowValue !== null && rowValue.toLowerCase() !== chainValue.toLowerCase()) {
      db[field] = rowValue;
      onChain[field] = chainValue;
    }
  };
  compare("questionHash", row.questionHash, hashToHex(chain.question_hash));
  compare("resolutionHash", row.resolutionHash, hashToHex(chain.resolution_hash));
  compare("metaUri", row.metaUri, chain.meta_uri);
  if (Object.keys(db).length > 0) {
    findings.push({ driftClass: "HASH_MISMATCH", dbValue: db, chainValue: onChain });
  }

  return findings;
}

export function findingKey(finding: DriftFinding, index = 0): string {
  return finding.id || `${finding.runId}:${finding.marketId}:${finding.driftClass}:${index}`;
}

export function isDriftClass(value: string): value is DriftClass {
  return (DRIFT_CLASSES as readonly string[]).includes(value);
}

export function isDriftAction(value: string): value is DriftAction {
  return (DRIFT_ACTIONS as readonly string[]).includes(value);
}
