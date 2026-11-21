import type { Market } from "@/lib/api/markets";
import { buildDbSnapshot, classifyDrift, findingKey, type DriftClassification, type DriftFinding } from "./drift";
import type { BatchedMarket } from "@/lib/stellar/market-batch";

export interface RecheckDeps {
  batcher: {
    loadMany(ids: readonly bigint[]): Promise<Map<string, BatchedMarket | Error>>;
  };
  backendMarket(marketId: string): Promise<Market>;
  ledgerTime: () => Promise<number>;
}

export type RecheckResult =
  | { status: "still-holds"; ledger: number; checkedAt: number }
  | { status: "resolved"; ledger: number; checkedAt: number }
  | { status: "changed"; detail: string; ledger: number; checkedAt: number }
  | { status: "unverifiable"; reason: string; ledger: number; checkedAt: number };

const MAX_BATCH = 200;
const BACKEND_CONCURRENCY = 3;

function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  const drain = () => {
    while (active < limit && waiting.length > 0) {
      const start = waiting.shift();
      start?.();
    }
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await new Promise<void>((resolve) => {
      if (active < limit) {
        active += 1;
        resolve();
      } else {
        waiting.push(() => {
          active += 1;
          resolve();
        });
      }
    });
    try {
      return await task();
    } finally {
      active -= 1;
      drain();
    }
  };
}

function isNotFound(error: Error): boolean {
  return /MarketNotFound|not found on chain/i.test(error.message) ||
    (error as Error & { code?: string }).code === "MarketNotFound";
}

function isArchived(error: Error): boolean {
  return /archived/i.test(error.message) ||
    (error as Error & { code?: string }).code === "ARCHIVED";
}

function stable(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function sameFinding(left: DriftClassification, right: DriftClassification): boolean {
  return left.driftClass === right.driftClass &&
    stable(left.dbValue) === stable(right.dbValue) &&
    stable(left.chainValue) === stable(right.chainValue);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

export async function recheckFindings(
  findings: readonly DriftFinding[],
  deps: RecheckDeps,
): Promise<Map<string, RecheckResult>> {
  const results = new Map<string, RecheckResult>();
  if (findings.length === 0) return results;

  const checkedAt = Date.now();
  let ledgerTimeMs: number;
  try {
    ledgerTimeMs = await deps.ledgerTime();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ledger time unavailable";
    for (const [index, finding] of findings.entries()) {
      results.set(findingKey(finding, index), { status: "unverifiable", reason, ledger: 0, checkedAt });
    }
    return results;
  }

  const groups = new Map<string, Array<{ finding: DriftFinding; index: number }>>();
  for (const [index, finding] of findings.entries()) {
    const id = String(finding.onChainMarketId ?? "");
    if (!/^\d+$/.test(id)) {
      results.set(findingKey(finding, index), {
        status: "unverifiable",
        reason: "invalid market id",
        ledger: 0,
        checkedAt,
      });
      continue;
    }
    const group = groups.get(id) ?? [];
    group.push({ finding, index });
    groups.set(id, group);
  }

  const ids = [...groups.keys()].map((id) => BigInt(id));
  const observed = new Map<string, BatchedMarket | Error>();
  for (const part of chunk(ids, MAX_BATCH)) {
    const loaded = await deps.batcher.loadMany(part);
    for (const [key, value] of loaded) observed.set(key, value);
  }

  const limit = createConcurrencyLimiter(BACKEND_CONCURRENCY);
  const backendCache = new Map<string, Promise<Market>>();
  const readBackend = (marketId: string): Promise<Market> => {
    const cached = backendCache.get(marketId);
    if (cached) return cached;
    const pending = limit(() => deps.backendMarket(marketId));
    backendCache.set(marketId, pending);
    return pending;
  };

  for (const [id, group] of groups) {
    const entry = observed.get(id) ?? new Error("market not returned by batcher");
    if (entry instanceof Error) {
      const reason = isNotFound(entry)
        ? "not found on chain"
        : isArchived(entry)
          ? "archived; restore needed"
          : entry.message;
      for (const { finding, index } of group) {
        const holds = isNotFound(entry) && finding.driftClass === "NOT_FOUND_ON_CHAIN";
        results.set(findingKey(finding, index), holds
          ? { status: "still-holds", ledger: 0, checkedAt }
          : { status: "unverifiable", reason, ledger: 0, checkedAt });
      }
      continue;
    }

    const ledger = entry.ledger;
    for (const { finding, index } of group) {
      let market: Market;
      try {
        market = await readBackend(finding.marketId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "backend read failed";
        results.set(findingKey(finding, index), {
          status: "unverifiable",
          reason: isArchived(new Error(message)) ? "archived; restore needed" : message,
          ledger,
          checkedAt,
        });
        continue;
      }

      const snapshot = buildDbSnapshot(market, {});
      const current = classifyDrift(snapshot, entry.view.market, ledgerTimeMs);
      if (current.length === 0) {
        results.set(findingKey(finding, index), { status: "resolved", ledger, checkedAt });
        continue;
      }
      const stillHolds = current.some((candidate) => sameFinding(candidate, finding));
      results.set(findingKey(finding, index), stillHolds
        ? { status: "still-holds", ledger, checkedAt }
        : {
            status: "changed",
            detail: current.map((candidate) => candidate.driftClass).join(", "),
            ledger,
            checkedAt,
          });
    }
  }

  return results;
}
