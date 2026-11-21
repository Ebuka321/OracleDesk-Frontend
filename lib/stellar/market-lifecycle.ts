import { xdr, Address, type rpc } from "@stellar/stellar-sdk";
import { CONTRACTS } from "./config";
import {
  decodeMarketCoreEvent,
  fetchContractEvents,
  marketTopicFilter,
  type EventWindow,
} from "./events";
import {
  decodeRegistryEvent,
  decodeResolverEvent,
  decodeSacTransferEvent,
} from "./contract-events";
import { reasoningRegistry, resolver } from "./clients";
import { priceYesBps } from "./generated/fpmm";
import type { Market } from "./generated/market-core";
import type { OnChainMarketTrace } from "./market-audit";
import { formatUsdc } from "./units";

export type LifecycleKind =
  | "created"
  | "trace"
  | "trades"
  | "price-resolution"
  | "proposed"
  | "finalized"
  | "resolved"
  | "voided"
  | "redeemed"
  | "fees-swept"
  | "pool-claimed"
  | "closed"
  | "retention-gap";

export interface LifecycleEntry {
  kind: LifecycleKind;
  ledger: number | null;
  closedAt: string | null;
  txHash: string | null;
  source: "market-core" | "registry" | "resolver" | "state";
  contractId: string | null;
  detail: Record<string, string>;
  eventIds: string[];
}

export type TimelineEvent =
  | {
      kind: "MarketCreated";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      creator: string;
      closeTime: bigint;
      seedAmount: bigint;
      initialYesBps: number;
    }
  | {
      kind: "Trade";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      trader: string;
      outcome: "Yes" | "No";
      isBuy: boolean;
      collateral: bigint;
      shares: bigint;
      fee: bigint;
      reserveYes: bigint;
      reserveNo: bigint;
    }
  | {
      kind: "MarketResolved";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      outcome: "Yes" | "No" | null;
    }
  | {
      kind: "Redeemed";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      holder: string;
      payout: bigint;
    }
  | {
      kind: "FeesSwept";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      recipient: string;
      amount: bigint;
    }
  | {
      kind: "TracePublished";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      traceId: bigint;
      agent: string;
      action: string;
      ipfsCid: string;
    }
  | {
      kind: "PriceResolution";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      outcome: "Yes" | "No";
      price: bigint;
    }
  | {
      kind: "ResolutionProposed";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      outcome: "Yes" | "No" | "Invalid";
    }
  | {
      kind: "ResolutionFinalized";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      outcome: "Yes" | "No" | "Invalid";
    }
  | {
      kind: "PoolClaimTransfer";
      id: string;
      ledger: number;
      closedAt: string;
      txHash: string;
      amount: bigint;
    };

function compareEventOrder(a: { ledger: number; id: string }, b: { ledger: number; id: string }): number {
  return a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function outcomeTag(v: unknown): "Yes" | "No" | "Invalid" | null {
  const tag = (v as { tag?: unknown } | null | undefined)?.tag;
  if (tag === "Yes" || tag === "No" || tag === "Invalid") return tag;
  if (v === "Yes" || v === "No" || v === "Invalid") return v;
  return null;
}

function hourBucketKey(closedAt: string, ledger: number): string {
  const ms = Date.parse(closedAt);
  if (!Number.isFinite(ms)) return `ledger:${Math.floor(ledger / 720)}`;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function buildLifecycle(input: {
  events: readonly TimelineEvent[];
  market: Market;
  resolverState: string;
  traces: readonly OnChainMarketTrace[];
  window: EventWindow;
  partial: boolean;
}): LifecycleEntry[] {
  const sorted = [...input.events].sort(compareEventOrder);
  const entries: LifecycleEntry[] = [];

  const hasCreated = sorted.some((e) => e.kind === "MarketCreated");
  const hasFinalized = sorted.some((e) => e.kind === "ResolutionFinalized");
  const priceResTxs = new Set(
    sorted.filter((e) => e.kind === "PriceResolution").map((e) => e.txHash),
  );
  const resolvedTxs = new Set(
    sorted.filter((e) => e.kind === "MarketResolved").map((e) => e.txHash),
  );

  // State-derived creation + retention gap when MarketCreated is outside RPC retention
  if (!hasCreated) {
    entries.push({
      kind: "created",
      ledger: null,
      closedAt: null,
      txHash: null,
      source: "state",
      contractId: CONTRACTS.marketCore,
      detail: {
        creator: input.market.creator,
        closeTime: input.market.close_time.toString(),
        stateDerived: "true",
      },
      eventIds: ["state:created"],
    });
    if (input.window.oldestLedger > 1) {
      entries.push({
        kind: "retention-gap",
        ledger: input.window.oldestLedger,
        closedAt: null,
        txHash: null,
        source: "state",
        contractId: null,
        detail: {
          oldestLedger: String(input.window.oldestLedger),
          partial: String(input.partial),
        },
        eventIds: [`gap:${input.window.oldestLedger}`],
      });
    }
  } else if (input.partial) {
    entries.push({
      kind: "retention-gap",
      ledger: input.window.oldestLedger,
      closedAt: null,
      txHash: null,
      source: "state",
      contractId: null,
      detail: {
        oldestLedger: String(input.window.oldestLedger),
        partial: "true",
      },
      eventIds: [`gap:partial:${input.window.oldestLedger}`],
    });
  }

  // Group Trade events into hourly buckets
  type TradeEvent = Extract<TimelineEvent, { kind: "Trade" }>;
  const tradeBuckets = new Map<string, TradeEvent[]>();
  const seenTraceIds = new Set<string>();

  for (const ev of sorted) {
    if (ev.kind === "Trade") {
      const key = hourBucketKey(ev.closedAt, ev.ledger);
      const list = tradeBuckets.get(key) ?? [];
      list.push(ev);
      tradeBuckets.set(key, list);
      continue;
    }

    if (ev.kind === "MarketCreated") {
      entries.push({
        kind: "created",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "market-core",
        contractId: CONTRACTS.marketCore,
        detail: {
          creator: ev.creator,
          seedAmount: formatUsdc(ev.seedAmount, { grouping: true }),
          initialYesBps: String(ev.initialYesBps),
        },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "TracePublished") {
      seenTraceIds.add(ev.traceId.toString());
      entries.push({
        kind: "trace",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "registry",
        contractId: CONTRACTS.reasoningRegistry,
        detail: {
          traceId: ev.traceId.toString(),
          agent: ev.agent,
          action: ev.action,
          ipfsCid: ev.ipfsCid,
        },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "PriceResolution") {
      entries.push({
        kind: "price-resolution",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "resolver",
        contractId: CONTRACTS.resolver,
        detail: {
          outcome: ev.outcome,
          price: ev.price.toString(),
          ...(resolvedTxs.has(ev.txHash) ? { groupedWithTx: ev.txHash } : {}),
        },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "ResolutionProposed") {
      entries.push({
        kind: "proposed",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "resolver",
        contractId: CONTRACTS.resolver,
        detail: { outcome: ev.outcome },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "ResolutionFinalized") {
      entries.push({
        kind: "finalized",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "resolver",
        contractId: CONTRACTS.resolver,
        detail: { outcome: ev.outcome },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "MarketResolved") {
      if (ev.outcome === null) {
        entries.push({
          kind: "voided",
          ledger: ev.ledger,
          closedAt: ev.closedAt,
          txHash: ev.txHash,
          source: "market-core",
          contractId: CONTRACTS.marketCore,
          detail: {
            voidReason: hasFinalized ? "Finalized as Invalid" : "Guardian void (no prior finalization)",
          },
          eventIds: [ev.id],
        });
      } else {
        entries.push({
          kind: "resolved",
          ledger: ev.ledger,
          closedAt: ev.closedAt,
          txHash: ev.txHash,
          source: "market-core",
          contractId: CONTRACTS.marketCore,
          detail: {
            outcome: ev.outcome,
            ...(priceResTxs.has(ev.txHash) ? { groupedWithTx: ev.txHash } : {}),
          },
          eventIds: [ev.id],
        });
      }
    } else if (ev.kind === "Redeemed") {
      entries.push({
        kind: "redeemed",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "market-core",
        contractId: CONTRACTS.marketCore,
        detail: {
          holder: ev.holder,
          payout: formatUsdc(ev.payout, { grouping: true }),
        },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "FeesSwept") {
      entries.push({
        kind: "fees-swept",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "market-core",
        contractId: CONTRACTS.marketCore,
        detail: {
          recipient: ev.recipient,
          amount: formatUsdc(ev.amount, { grouping: true }),
        },
        eventIds: [ev.id],
      });
    } else if (ev.kind === "PoolClaimTransfer") {
      entries.push({
        kind: "pool-claimed",
        ledger: ev.ledger,
        closedAt: ev.closedAt,
        txHash: ev.txHash,
        source: "market-core",
        contractId: CONTRACTS.usdc,
        detail: {
          amount: formatUsdc(ev.amount, { grouping: true }),
        },
        eventIds: [ev.id],
      });
    }
  }

  // Emit summarized trade buckets
  for (const [, trades] of tradeBuckets) {
    let buyCollateral = 0n;
    let sellCollateral = 0n;
    for (const t of trades) {
      if (t.isBuy) buyCollateral += t.collateral;
      else sellCollateral += t.collateral;
    }
    const first = trades[0]!;
    const last = trades[trades.length - 1]!;
    const beforeBps = Number(priceYesBps(first.reserveYes, first.reserveNo));
    const afterBps = Number(priceYesBps(last.reserveYes, last.reserveNo));

    entries.push({
      kind: "trades",
      ledger: first.ledger,
      closedAt: first.closedAt,
      txHash: null,
      source: "market-core",
      contractId: CONTRACTS.marketCore,
      detail: {
        count: String(trades.length),
        buyCollateralRaw: buyCollateral.toString(),
        sellCollateralRaw: sellCollateral.toString(),
        buyCollateral: formatUsdc(buyCollateral, { grouping: true }),
        sellCollateral: formatUsdc(sellCollateral, { grouping: true }),
        yesBpsBefore: String(beforeBps),
        yesBpsAfter: String(afterBps),
      },
      eventIds: trades.map((t) => t.id),
    });
  }

  // State-derived traces outside the RPC window
  for (const trace of input.traces) {
    if (seenTraceIds.has(trace.traceId.toString())) continue;
    entries.push({
      kind: "trace",
      ledger: null,
      closedAt: new Date(Number(trace.publishedAt) * 1000).toISOString(),
      txHash: null,
      source: "state",
      contractId: CONTRACTS.reasoningRegistry,
      detail: {
        traceId: trace.traceId.toString(),
        agent: trace.agent,
        action: trace.action,
        ipfsCid: trace.ipfsCid,
        stateDerived: "true",
      },
      eventIds: [`state:trace:${trace.traceId}`],
    });
  }

  // State-derived pool-claimed if lp_claimed is true and no transfer event was found
  const hasPoolClaim = entries.some((e) => e.kind === "pool-claimed");
  if (input.market.lp_claimed && !hasPoolClaim) {
    entries.push({
      kind: "pool-claimed",
      ledger: null,
      closedAt: null,
      txHash: null,
      source: "state",
      contractId: CONTRACTS.marketCore,
      detail: { stateDerived: "true" },
      eventIds: ["state:pool-claimed"],
    });
  }

  // Sort by ledger (nulls placed by closedAt or at end) then eventId
  return entries.sort((a, b) => {
    if (a.ledger !== null && b.ledger !== null) {
      return a.ledger - b.ledger || (a.eventIds[0] ?? "").localeCompare(b.eventIds[0] ?? "");
    }
    if (a.kind === "created" && a.ledger === null) return -1;
    if (b.kind === "created" && b.ledger === null) return 1;
    if (a.kind === "retention-gap" && b.ledger !== null && b.kind !== "created") return -1;
    if (b.kind === "retention-gap" && a.ledger !== null && a.kind !== "created") return 1;
    const ta = a.closedAt ? Date.parse(a.closedAt) : Number.MAX_SAFE_INTEGER;
    const tb = b.closedAt ? Date.parse(b.closedAt) : Number.MAX_SAFE_INTEGER;
    return ta - tb;
  });
}

type EventServer = Pick<rpc.Server, "getHealth" | "getEvents">;

export async function fetchMarketLifecycleEvents(
  marketId: bigint,
  opts: {
    fromLedger?: number;
    signal?: AbortSignal;
    server?: EventServer;
    market?: Pick<Market, "lp_claimed" | "creator">;
  } = {},
): Promise<{ events: TimelineEvent[]; window: EventWindow; partial: boolean }> {
  const rrSpec = reasoningRegistry().spec;
  const resSpec = resolver().spec;

  const [mcRead, rrRead, resRead] = await Promise.all([
    fetchContractEvents({
      contractId: CONTRACTS.marketCore,
      topicFilters: marketTopicFilter(marketId, [
        "MarketCreated",
        "MarketResolved",
        "Redeemed",
        "FeesSwept",
        "Trade",
      ]),
      startLedger: opts.fromLedger,
      maxPages: 10,
      signal: opts.signal,
      server: opts.server,
    }),
    fetchContractEvents({
      contractId: CONTRACTS.reasoningRegistry,
      topicFilters: [rrSpec.eventTopicFilter("TracePublished", { market_id: marketId })],
      startLedger: opts.fromLedger,
      maxPages: 10,
      signal: opts.signal,
      server: opts.server,
    }),
    fetchContractEvents({
      contractId: CONTRACTS.resolver,
      topicFilters: [
        resSpec.eventTopicFilter("PriceResolution", { market_id: marketId }),
        resSpec.eventTopicFilter("ResolutionProposed", { market_id: marketId }),
        resSpec.eventTopicFilter("ResolutionFinalized", { market_id: marketId }),
      ],
      startLedger: opts.fromLedger,
      maxPages: 10,
      signal: opts.signal,
      server: opts.server,
    }),
  ]);

  const events: TimelineEvent[] = [];

  for (const raw of mcRead.events) {
    const fakeResp = {
      type: "contract" as const,
      id: raw.id,
      ledger: raw.ledger,
      ledgerClosedAt: raw.ledgerClosedAt,
      txHash: raw.txHash,
      contractId: { contractId: () => raw.contractId } as unknown as rpc.Api.EventResponse["contractId"],
      inSuccessfulContractCall: true,
      topic: raw.topics,
      value: raw.value,
      pagingToken: raw.id,
    };
    const dec = decodeMarketCoreEvent(fakeResp);
    if (!dec) continue;
    if (dec.kind === "MarketCreated") {
      events.push({
        kind: "MarketCreated",
        id: dec.meta.id,
        ledger: dec.meta.ledger,
        closedAt: dec.meta.ledgerClosedAt,
        txHash: dec.meta.txHash,
        creator: dec.creator,
        closeTime: dec.closeTime,
        seedAmount: dec.seedAmount,
        initialYesBps: dec.initialYesBps,
      });
    } else if (dec.kind === "Trade") {
      events.push({
        kind: "Trade",
        id: dec.meta.id,
        ledger: dec.meta.ledger,
        closedAt: dec.meta.ledgerClosedAt,
        txHash: dec.meta.txHash,
        trader: dec.trader,
        outcome: dec.outcome,
        isBuy: dec.isBuy,
        collateral: dec.collateral,
        shares: dec.shares,
        fee: dec.fee,
        reserveYes: dec.reserveYes,
        reserveNo: dec.reserveNo,
      });
    } else if (dec.kind === "MarketResolved") {
      events.push({
        kind: "MarketResolved",
        id: dec.meta.id,
        ledger: dec.meta.ledger,
        closedAt: dec.meta.ledgerClosedAt,
        txHash: dec.meta.txHash,
        outcome: dec.outcome,
      });
    } else if (dec.kind === "Redeemed") {
      events.push({
        kind: "Redeemed",
        id: dec.meta.id,
        ledger: dec.meta.ledger,
        closedAt: dec.meta.ledgerClosedAt,
        txHash: dec.meta.txHash,
        holder: dec.holder,
        payout: dec.payout,
      });
    } else if (dec.kind === "FeesSwept") {
      events.push({
        kind: "FeesSwept",
        id: dec.meta.id,
        ledger: dec.meta.ledger,
        closedAt: dec.meta.ledgerClosedAt,
        txHash: dec.meta.txHash,
        recipient: dec.recipient,
        amount: dec.amount,
      });
    }
  }

  for (const raw of rrRead.events) {
    const dec = decodeRegistryEvent(raw);
    if (!dec || dec.name !== "TracePublished") continue;
    events.push({
      kind: "TracePublished",
      id: raw.id,
      ledger: raw.ledger,
      closedAt: raw.ledgerClosedAt,
      txHash: raw.txHash,
      traceId: BigInt((dec.data.trace_id as bigint | number | string) ?? 0),
      agent: String(dec.data.agent ?? ""),
      action: String(dec.data.action ?? ""),
      ipfsCid: String(dec.data.ipfs_cid ?? ""),
    });
  }

  for (const raw of resRead.events) {
    const dec = decodeResolverEvent(raw);
    if (!dec) continue;
    const outcome = outcomeTag(dec.data.outcome);
    if (dec.name === "PriceResolution" && (outcome === "Yes" || outcome === "No")) {
      events.push({
        kind: "PriceResolution",
        id: raw.id,
        ledger: raw.ledger,
        closedAt: raw.ledgerClosedAt,
        txHash: raw.txHash,
        outcome,
        price: BigInt((dec.data.price as bigint | number | string) ?? 0),
      });
    } else if (dec.name === "ResolutionProposed" && outcome) {
      events.push({
        kind: "ResolutionProposed",
        id: raw.id,
        ledger: raw.ledger,
        closedAt: raw.ledgerClosedAt,
        txHash: raw.txHash,
        outcome,
      });
    } else if (dec.name === "ResolutionFinalized" && outcome) {
      events.push({
        kind: "ResolutionFinalized",
        id: raw.id,
        ledger: raw.ledger,
        closedAt: raw.ledgerClosedAt,
        txHash: raw.txHash,
        outcome,
      });
    }
  }

  if (opts.market?.lp_claimed) {
    const sacRead = await fetchContractEvents({
      contractId: CONTRACTS.usdc,
      topics: [
        xdr.ScVal.scvSymbol("transfer").toXDR("base64"),
        new Address(CONTRACTS.marketCore).toScVal().toXDR("base64"),
        new Address(opts.market.creator).toScVal().toXDR("base64"),
        "*",
      ],
      startLedger: opts.fromLedger,
      maxPages: 5,
      signal: opts.signal,
      server: opts.server,
    });
    for (const raw of sacRead.events) {
      const t = decodeSacTransferEvent(raw);
      if (t) {
        events.push({
          kind: "PoolClaimTransfer",
          id: raw.id,
          ledger: raw.ledger,
          closedAt: raw.ledgerClosedAt,
          txHash: raw.txHash,
          amount: t.amount,
        });
      }
    }
  }

  return {
    events,
    window: mcRead.window,
    partial: mcRead.partial || rrRead.partial || resRead.partial,
  };
}
