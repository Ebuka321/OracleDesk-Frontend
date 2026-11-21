import { StrKey } from "@stellar/stellar-sdk";

export interface TradeEvent {
  eventId: string; onChainMarketId: string; trader: string; direction: "YES" | "NO"; isBuy: boolean;
  collateralRaw: string; sharesRaw: string; feeRaw: string; priceYesBps: number;
  txHash: string; ledger: number; marketQuestion: string | null; closedAt?: string;
}
export interface TraceEvent {
  onChainTraceId: string; onChainMarketId: string; traceId: string | null;
  agent: string; action: string; ledger: number; txHash: string; closedAt?: string;
}
export interface MarketPricePayload {
  onChainMarketId: string;
  marketId: string;
  priceYesBps: number;
  ledger: number;
  eventId: string;
  ts: number;
}

export interface CopyTradeConfirmedEvent {
  copyTradeId: string;
  txHash: string;
  status: "CONFIRMED" | "EXECUTED";
  amountRaw?: string;
  confirmedAt?: string;
}

export interface PaymentConfirmedEvent {
  txHash: string;
  paymentId?: string;
  status: "CONFIRMED" | "VERIFIED";
  amountRaw: string;
  confirmedAt?: string;
  expiresAt?: string;
}

export interface PassExpiringEvent {
  passId?: string;
  expiresAt: string;
  remainingMinutes?: number;
}

export type PrivateRealtimeEvent =
  | { type: "COPY_TRADE_CONFIRMED"; payload: CopyTradeConfirmedEvent; receivedAt: number }
  | { type: "PAYMENT_CONFIRMED"; payload: PaymentConfirmedEvent; receivedAt: number }
  | { type: "PASS_EXPIRING"; payload: PassExpiringEvent; receivedAt: number };

export type RealtimeEvent =
  | { type: "TRADE_EXECUTED"; payload: TradeEvent; receivedAt: number }
  | { type: "REASONING_PUBLISHED"; payload: TraceEvent; receivedAt: number }
  | { type: "MARKET_PRICE"; payload: MarketPricePayload; receivedAt: number };

export const isHash = (v: unknown): v is string => typeof v === "string" && /^[a-f\d]{64}$/i.test(v);
export const isRaw = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,38})$/.test(v) && BigInt(v) <= (1n << 127n) - 1n;
export const isMarketId = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) < 1n << 64n;
export const isAddress = (v: unknown): v is string => typeof v === "string" && (StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v));
const isLedger = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const validTime = (v: unknown) => v === undefined || (typeof v === "string" && Number.isFinite(Date.parse(v)));

let droppedMarketPriceCount = 0;
export function getDroppedMarketPriceCount(): number {
  return droppedMarketPriceCount;
}
export function resetDroppedMarketPriceCount(): void {
  droppedMarketPriceCount = 0;
}

/**
 * Strict guard for MARKET_PRICE stream payloads.
 * priceYesBps must be an integer from 0 to 10000,
 * ledger a positive safe integer,
 * eventId and ids bounded strings,
 * ts a finite positive number.
 * Malformed payloads are counted and dropped; never throws.
 */
export function isMarketPricePayload(v: unknown): v is MarketPricePayload {
  if (
    object(v) &&
    isMarketId(v.onChainMarketId) &&
    typeof v.marketId === "string" &&
    v.marketId.length > 0 &&
    v.marketId.length <= 128 &&
    Number.isInteger(v.priceYesBps) &&
    (v.priceYesBps as number) >= 0 &&
    (v.priceYesBps as number) <= 10000 &&
    Number.isSafeInteger(v.ledger) &&
    (v.ledger as number) > 0 &&
    typeof v.eventId === "string" &&
    v.eventId.length > 0 &&
    v.eventId.length <= 128 &&
    typeof v.ts === "number" &&
    Number.isFinite(v.ts) &&
    v.ts > 0
  ) {
    return true;
  }
  droppedMarketPriceCount++;
  return false;
}

export function isTradeEvent(v: unknown): v is TradeEvent {
  return object(v) && typeof v.eventId === "string" && v.eventId.length > 0 && v.eventId.length < 150 &&
    isMarketId(v.onChainMarketId) && isAddress(v.trader) && (v.direction === "YES" || v.direction === "NO") &&
    typeof v.isBuy === "boolean" && isRaw(v.collateralRaw) && isRaw(v.sharesRaw) && isRaw(v.feeRaw) &&
    Number.isInteger(v.priceYesBps) && (v.priceYesBps as number) >= 0 && (v.priceYesBps as number) <= 10000 &&
    isHash(v.txHash) && isLedger(v.ledger) && (v.marketQuestion === null || typeof v.marketQuestion === "string") && validTime(v.closedAt);
}
export function isTraceEvent(v: unknown): v is TraceEvent {
  return object(v) && isMarketId(v.onChainTraceId) && isMarketId(v.onChainMarketId) && isAddress(v.agent) &&
    typeof v.action === "string" && v.action.length > 0 && v.action.length < 200 &&
    (v.traceId === null || typeof v.traceId === "string") && isHash(v.txHash) && isLedger(v.ledger) && validTime(v.closedAt);
}

const MIN_VALID_DATE_MS = Date.UTC(2020, 0, 1);
const MAX_VALID_DATE_MS = Date.UTC(2100, 0, 1);

function isBoundedString(v: unknown, maxLen = 128): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

function isBoundedIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 10 || v.length > 64) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms >= MIN_VALID_DATE_MS && ms <= MAX_VALID_DATE_MS;
}

function isOptionalBoundedIsoDate(v: unknown): v is string | undefined {
  return v === undefined || isBoundedIsoDate(v);
}

/**
 * Strict hand-written guard for COPY_TRADE_CONFIRMED private events.
 * Rejects unknown shapes, non-string ids, bad statuses, malformed amounts, and out-of-range dates.
 */
export function isCopyTradeConfirmedEvent(v: unknown): v is CopyTradeConfirmedEvent {
  if (!object(v)) return false;
  if (!isBoundedString(v.copyTradeId)) return false;
  if (!isHash(v.txHash)) return false;
  if (v.status !== "CONFIRMED" && v.status !== "EXECUTED") return false;
  if (v.amountRaw !== undefined && !isRaw(v.amountRaw)) return false;
  if (!isOptionalBoundedIsoDate(v.confirmedAt)) return false;
  return true;
}

/**
 * Strict hand-written guard for PAYMENT_CONFIRMED private events.
 */
export function isPaymentConfirmedEvent(v: unknown): v is PaymentConfirmedEvent {
  if (!object(v)) return false;
  if (!isHash(v.txHash)) return false;
  if (v.paymentId !== undefined && !isBoundedString(v.paymentId)) return false;
  if (v.status !== "CONFIRMED" && v.status !== "VERIFIED") return false;
  if (!isRaw(v.amountRaw)) return false;
  if (!isOptionalBoundedIsoDate(v.confirmedAt)) return false;
  if (!isOptionalBoundedIsoDate(v.expiresAt)) return false;
  return true;
}

/**
 * Strict hand-written guard for PASS_EXPIRING private events.
 */
export function isPassExpiringEvent(v: unknown): v is PassExpiringEvent {
  if (!object(v)) return false;
  if (!isBoundedIsoDate(v.expiresAt)) return false;
  if (v.passId !== undefined && !isBoundedString(v.passId)) return false;
  if (
    v.remainingMinutes !== undefined &&
    (typeof v.remainingMinutes !== "number" || !Number.isFinite(v.remainingMinutes) || v.remainingMinutes < 0 || v.remainingMinutes > 60 * 24 * 365)
  ) {
    return false;
  }
  return true;
}

/** Redacted summary of a dropped private payload (keys only, never raw values/tokens/addresses). */
export function redactPayloadForLog(payload: unknown): { kind: string; keys?: string[] } {
  if (payload === null) return { kind: "null" };
  if (Array.isArray(payload)) return { kind: "array" };
  if (typeof payload !== "object") return { kind: typeof payload };
  return { kind: "object", keys: Object.keys(payload as Record<string, unknown>).slice(0, 16) };
}

export const eventKey = (event: RealtimeEvent) => event.type === "TRADE_EXECUTED" ? `trade:${event.payload.eventId}` : `trace:${event.payload.onChainTraceId}`;
