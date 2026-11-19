/**
 * W3C Trace Context request correlation (issue #124).
 *
 * Every backend request from lib/api/client.ts carries a `traceparent`
 * header generated here; multi-step flows (sign-in, premium unlock, copy
 * trade, market generation) run inside `withOperation` so all of their
 * requests share one trace id, and error UIs show a short reference derived
 * from it ("Reference: 4bf92f35") that maintainers can grep in backend logs.
 *
 * Optional Soroban RPC measurement: when NEXT_PUBLIC_OTEL_EXPORTER_URL is
 * set, `initTracing()` patches `fetch` once to record spans for RPC-origin
 * requests (method, duration, HTTP status, JSON-RPC error code) and exports
 * them over OTLP/HTTP JSON with a sample rate — no OpenTelemetry packages in
 * the default bundle, and no `traceparent` on third-party RPC requests
 * unless NEXT_PUBLIC_OTEL_PROPAGATE_TO_RPC=1. Span attributes are filtered
 * here (sensitive keys dropped, StrKey/JWT values redacted) before anything
 * is buffered, and again on flush.
 */

import { NETWORK_LABEL, RPC_URL } from "@/lib/stellar/config";

export interface TraceCtx {
  /** 32 lowercase hex characters, never all zeros. */
  traceId: string;
  /** 16 lowercase hex characters, never all zeros. */
  spanId: string;
  sampled: boolean;
}

export type OperationName = "sign-in" | "premium-unlock" | "copy-trade" | "generate-market";

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < bytes; i++) values[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newTrace(sampled = true): TraceCtx {
  let traceId = randomHex(16);
  let spanId = randomHex(8);
  while (/^0+$/.test(traceId)) traceId = randomHex(16); // spec: never all zeros
  while (/^0+$/.test(spanId)) spanId = randomHex(8);
  return { traceId, spanId, sampled };
}

/** A new span in the same trace (new span id, same trace id and flag). */
export function childSpan(ctx: TraceCtx): TraceCtx {
  return { traceId: ctx.traceId, spanId: randomHex(8), sampled: ctx.sampled };
}

/** `00-<trace>-<span>-0<1|0>` — lowercase hex, valid W3C traceparent. */
export function toTraceparent(ctx: TraceCtx): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0([01])$/;

export function parseTraceparent(value: string | null | undefined): TraceCtx | null {
  if (!value) return null;
  const match = TRACEPARENT_RE.exec(value.trim());
  if (!match) return null;
  const [, traceId, spanId, flag] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: flag === "1" };
}

/** First 8 hex characters of a trace id, for "Reference: 4bf92f35" in the UI. */
export function shortRef(traceId: string): string {
  return traceId.slice(0, 8);
}

/* ------------------------------------------------------------------ *
 * Active operations
 * ------------------------------------------------------------------ */

interface Operation {
  name: OperationName;
  ctx: TraceCtx;
  attrs: Record<string, string | number | boolean>;
}

const opStack: Operation[] = [];

/**
 * Runs `fn` with a trace context that every nested backend request shares.
 * A module-level stack stands in for AsyncLocalStorage (browsers have
 * none); pass `ctx` explicitly where concurrency needs precision.
 */
export async function withOperation<T>(name: OperationName, fn: (ctx: TraceCtx) => Promise<T>): Promise<T> {
  const parent = opStack[opStack.length - 1];
  const op: Operation = { name, ctx: parent ? childSpan(parent.ctx) : newTrace(), attrs: {} };
  opStack.push(op);
  try {
    return await fn(op.ctx);
  } finally {
    const index = opStack.lastIndexOf(op);
    if (index !== -1) opStack.splice(index, 1);
  }
}

/** The innermost active operation's context, or null outside any operation. */
export function currentTrace(): TraceCtx | null {
  return opStack[opStack.length - 1]?.ctx ?? null;
}

export function currentOperation(): { name: OperationName; ctx: TraceCtx; attrs: Record<string, string | number | boolean> } | null {
  return opStack[opStack.length - 1] ?? null;
}

/** Records an attribute on the active operation's span (no-op outside one). */
export function setSpanAttribute(key: string, value: string | number | boolean): void {
  const op = opStack[opStack.length - 1];
  if (op) op.attrs[key] = value;
}

/** `"<message> Reference: 4bf92f35"` — uses the error's own request id when present. */
export function formatErrorWithReference(err: unknown, referenceId?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  const fromError = (err as { requestId?: unknown } | null)?.requestId;
  const ref = referenceId ?? (typeof fromError === "string" ? fromError : undefined);
  if (!ref) return message;
  return `${message} Reference: ${shortRef(ref)}`;
}

/* ------------------------------------------------------------------ *
 * RPC spans + OTLP export (opt-in)
 * ------------------------------------------------------------------ */

export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  ok: boolean;
}

const SENSITIVE_ATTR_KEY_RE = /token|authorization|signature|xdr|address|holder|trader|^from$|^to$|envelope|secret/i;
const SENSITIVE_ATTR_VALUE_RE =
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b[GCM][A-Z2-7]{55}\b|\bS[A-Z2-7]{55}\b|\b[A-Za-z0-9+/]{80,}={0,2}\b/;

/**
 * Drops sensitive attribute keys and redacts StrKey/JWT/secret/base64
 * values — the exported spans must never carry them (tested).
 */
export function sanitizeSpanAttributes(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SENSITIVE_ATTR_KEY_RE.test(key)) continue;
    if (typeof value === "string") {
      if (SENSITIVE_ATTR_VALUE_RE.test(value)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value !== undefined && value !== null) {
      out[key] = String(value).slice(0, 200);
    }
  }
  return out;
}

/** TraceIdRatioBasedSampler equivalent: first 8 hex of the id vs the rate. */
export function shouldSample(traceId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const ratio = parseInt(traceId.slice(0, 8), 16) / 0xffffffff;
  return ratio < rate;
}

let spanSink: ((span: SpanRecord) => void) | null = null;
/** Pluggable sink (tests, or the OTLP exporter). */
export function setSpanSink(sink: ((span: SpanRecord) => void) | null): void {
  spanSink = sink;
}

function tracingEnabled(): boolean {
  return Boolean((process.env.NEXT_PUBLIC_OTEL_EXPORTER_URL ?? "").trim());
}

function sampleRate(): number {
  const raw = Number(process.env.NEXT_PUBLIC_OTEL_SAMPLE_RATE);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.1;
}

let fetchPatched = false;

/**
 * Patches globalThis.fetch once (only when tracing is enabled) to record
 * spans for requests to the RPC origin: JSON-RPC method (read from a string
 * body), duration, HTTP status and JSON-RPC error code. Other origins pass
 * through untouched, and RPC requests never gain a `traceparent` header
 * unless NEXT_PUBLIC_OTEL_PROPAGATE_TO_RPC=1 (third-party RPC providers may
 * reject unknown headers and it would trigger CORS preflights).
 */
export function instrumentFetch(): void {
  if (fetchPatched || typeof window === "undefined") return;
  let rpcOrigin: string;
  try {
    rpcOrigin = new URL(RPC_URL).origin;
  } catch {
    return;
  }
  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let isRpc = false;
    let rpcMethod: string | undefined;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      isRpc = new URL(url, window.location?.href).origin === rpcOrigin;
    } catch {
      isRpc = false;
    }

    let nextInit = init;
    if (isRpc) {
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as { method?: unknown };
          if (typeof parsed?.method === "string") rpcMethod = parsed.method;
        } catch {
          // Non-JSON body: span still records method-less HTTP.
        }
      }
      if (process.env.NEXT_PUBLIC_OTEL_PROPAGATE_TO_RPC === "1") {
        const headers = new Headers(init?.headers);
        if (!headers.has("traceparent")) {
          headers.set("traceparent", toTraceparent(childSpan(currentTrace() ?? newTrace())));
          nextInit = { ...init, headers };
        }
      }
    }

    const startNs = BigInt(Math.round(performance.now() * 1e6)) + BigInt(Date.now()) * 1_000_000n;
    const started = Date.now();
    try {
      const response = await original(input, nextInit);
      if (isRpc && spanSink) emitSpan(rpcMethod, startNs, started, response.status, true);
      return response;
    } catch (error) {
      if (isRpc && spanSink) emitSpan(rpcMethod, startNs, started, 0, false);
      throw error;
    }
  };
  fetchPatched = true;
}

function emitSpan(
  rpcMethod: string | undefined,
  startNs: bigint,
  started: number,
  httpStatus: number,
  ok: boolean,
): void {
  const trace = currentTrace() ?? newTrace();
  const ended = Date.now();
  spanSink?.({
    name: rpcMethod ? `rpc ${rpcMethod}` : "rpc http",
    traceId: trace.traceId,
    spanId: randomHex(8),
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: (startNs + BigInt(Math.max(0, ended - started)) * 1_000_000n).toString(),
    attributes: sanitizeSpanAttributes({
      "rpc.method": rpcMethod ?? "unknown",
      "http.status_code": httpStatus,
      "http.duration_ms": Math.max(0, ended - started),
    }),
    ok,
  });
}

/* ------------------------------------------------------------------ *
 * OTLP/HTTP export (only when NEXT_PUBLIC_OTEL_EXPORTER_URL is set)
 * ------------------------------------------------------------------ */

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
}

function otlpAttributes(attrs: Record<string, string | number | boolean>): OtlpAttribute[] {
  return Object.entries(sanitizeSpanAttributes(attrs)).map(([key, value]) => ({
    key,
    value:
      typeof value === "boolean"
        ? { boolValue: value }
        : typeof value === "number"
          ? { intValue: String(Math.round(value)) }
          : { stringValue: value },
  }));
}

let buffer: SpanRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function buildOtlpPayload(spans: SpanRecord[]): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttributes({
            "service.name": "oracledesk-frontend",
            "service.version": process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev",
            "deployment.environment": NETWORK_LABEL,
          }),
        },
        scopeSpans: [
          {
            scope: { name: "oracledesk-frontend" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              startTimeUnixNano: span.startTimeUnixNano,
              endTimeUnixNano: span.endTimeUnixNano,
              attributes: otlpAttributes(span.attributes),
              status: { code: span.ok ? 1 : 2 }, // OK / ERROR
            })),
          },
        ],
      },
    ],
  };
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const spans = buffer;
  buffer = [];
  const url = (process.env.NEXT_PUBLIC_OTEL_EXPORTER_URL ?? "").trim();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildOtlpPayload(spans)),
      keepalive: true,
    });
  } catch {
    // Telemetry must never surface as an app error; drop the batch.
  }
}

function enqueue(span: SpanRecord): void {
  buffer.push(span);
  if (buffer.length >= 20) void flush();
  else if (!flushTimer && typeof window !== "undefined") {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 5_000);
  }
}

let initialized = false;

/**
 * Called once from the layout (ErrorReportingInit). Completely off unless
 * NEXT_PUBLIC_OTEL_EXPORTER_URL is set; window-safe for static prerender.
 */
export function initTracing(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  if (!tracingEnabled()) return;
  setSpanSink((span) => {
    if (shouldSample(span.traceId, sampleRate())) enqueue(span);
  });
  instrumentFetch();
}
