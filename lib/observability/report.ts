/**
 * Opt-in client error reporting (issue #123).
 *
 * No-op unless NEXT_PUBLIC_ERROR_REPORTING_DSN is set at build time AND the
 * user has consented (localStorage `oracledesk_error_reporting`, default
 * denied, Do Not Track = denied). Everything that leaves the browser goes
 * through lib/observability/redact.ts twice — once field by field, once on
 * the serialized event, dropping the event if a JWT or secret seed survives.
 *
 * reportError() always returns a short reference id, even when reporting is
 * off, so the UI can show "Reference: K3F9QZ2A" and a user can quote it to
 * support; without a DSN the id is local-only.
 */

import { CONTRACTS, NETWORK_LABEL } from "@/lib/stellar/config";
import { toReportFields, type ContractName } from "@/lib/stellar/errors";
import { getRedactionSalt as saltFromStorage, makeAllowlist, redactEvent, redactString } from "./redact";

export type ReportLevel = "error" | "warning" | "info";

export interface ReportContext {
  route?: string;
  feature?: "buy" | "sell" | "redeem" | "premium" | "copy-trade" | "connect" | "verify" | "admin";
  contract?: ContractName;
  walletModule?: string;
  extra?: Record<string, string | number | boolean>;
}

export interface Breadcrumb {
  category: string;
  message: string;
  timestamp: number;
}

export interface StackFrame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

export interface RedactedEvent {
  id: string;
  timestamp: string;
  release: string;
  environment: string;
  route: string;
  level: ReportLevel;
  kind?: string;
  code?: string;
  contract?: string;
  apiCode?: string;
  httpStatus?: number;
  requestId?: string;
  walletModule?: string;
  message: string;
  stack?: StackFrame[];
  breadcrumbs: Breadcrumb[];
  tags: Record<string, string>;
  extra?: Record<string, unknown>;
}

export interface ReportTransport {
  send(event: RedactedEvent): Promise<void>;
}

export interface InitReportingOptions {
  dsn: string;
  release: string;
  environment: string;
  sampleRate?: number;
  transport?: ReportTransport;
}

const CONSENT_KEY = "oracledesk_error_reporting";
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const DEDUPE_WINDOW_MS = 60_000;
const MAX_BREADCRUMBS = 20;

const DSN = (process.env.NEXT_PUBLIC_ERROR_REPORTING_DSN ?? "").trim();
const DEFAULT_RELEASE = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

const allowlist = makeAllowlist(Object.values(CONTRACTS));

interface ReporterState {
  dsn: string;
  release: string;
  environment: string;
  sampleRate: number;
  transport: ReportTransport | null;
  breadcrumbs: Breadcrumb[];
  sentAt: number[];
  signatures: Map<string, number>;
  reporting: boolean; // re-entrancy guard
  consentPromptShown: boolean;
  route: string;
}

const state: ReporterState = {
  dsn: DSN,
  release: DEFAULT_RELEASE,
  environment: NETWORK_LABEL,
  sampleRate: 1,
  transport: null,
  breadcrumbs: [],
  sentAt: [],
  signatures: new Map(),
  reporting: false,
  consentPromptShown: false,
  route: typeof window === "undefined" ? "" : window.location.pathname,
};

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

function doNotTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  return navigator.doNotTrack === "1" || (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/** Consent outside a browser (tests, SSR): localStorage is unavailable, so keep it in memory. */
let memoryConsent: "granted" | "denied" | null = null;

export function hasReportingConsentChoice(): boolean {
  if (typeof window === "undefined") return memoryConsent !== null;
  try {
    return window.localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
}

export function getReportingConsent(): boolean {
  if (doNotTrack()) return false;
  if (typeof window === "undefined") return memoryConsent === "granted";
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

export function setReportingConsent(granted: boolean): void {
  memoryConsent = granted ? "granted" : "denied";
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch {
    // Storage disabled: the session simply stays at the in-memory value.
  }
}

let consentPromptHandler: (() => void) | null = null;
/** Called once per session the first time an error happens with no consent choice yet. */
export function setConsentPromptHandler(handler: (() => void) | null): void {
  consentPromptHandler = handler;
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

export function isReportingConfigured(): boolean {
  return DSN.length > 0;
}

/** Sentry DSN (`https://<key>@<host>/<project>`) → envelope ingest URL. */
function sentryIngestUrl(dsn: string): string | null {
  const match = /^https:\/\/[^@/]+@([^/]+)\/(\d+)$/.exec(dsn);
  if (!match) return null;
  return `https://${match[1]}/api/${match[2]}/envelope/`;
}

function defaultTransport(dsn: string): ReportTransport {
  const envelopeUrl = sentryIngestUrl(dsn);
  if (envelopeUrl) {
    return {
      async send(event) {
        const body =
          `${JSON.stringify({ event_id: event.id.replace(/-/g, ""), sent_at: new Date().toISOString() })}\n` +
          `${JSON.stringify({ type: "event" })}\n` +
          `${JSON.stringify(event)}\n`;
        await fetch(envelopeUrl, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope" },
          body,
          keepalive: true,
          mode: "cors",
        });
      },
    };
  }
  return {
    async send(event) {
      await fetch(dsn, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
        keepalive: true,
        mode: "cors",
      });
    },
  };
}

export function initReporting(opts: InitReportingOptions): void {
  state.dsn = opts.dsn.trim();
  state.release = opts.release || DEFAULT_RELEASE;
  state.environment = opts.environment;
  state.sampleRate = opts.sampleRate ?? 1;
  state.transport = opts.transport ?? (state.dsn ? defaultTransport(state.dsn) : null);
}

function ensureInitialized(): void {
  if (state.transport) return;
  if (!state.dsn) return;
  state.transport = defaultTransport(state.dsn);
}

/* ------------------------------------------------------------------ *
 * Breadcrumbs and route
 * ------------------------------------------------------------------ */

export function setCurrentRoute(route: string): void {
  state.route = route.split(/[?#]/)[0];
}

export function addBreadcrumb(category: string, message: string): void {
  state.breadcrumbs.push({ category, message: redactString(message, { salt: saltFromStorage(), allowlist }), timestamp: Date.now() });
  if (state.breadcrumbs.length > MAX_BREADCRUMBS) state.breadcrumbs.splice(0, state.breadcrumbs.length - MAX_BREADCRUMBS);
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // Crockford-ish, no confusing letters

function newReferenceId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

function parseStack(stack: string | undefined): StackFrame[] | undefined {
  if (!stack) return undefined;
  const frames: StackFrame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const match = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!match) continue;
    const [, fn, filename, lineno, colno] = match;
    if (/^(chrome-extension|safari-extension|moz-extension):\/\//.test(filename)) continue; // extension noise
    frames.push({
      function: fn || undefined,
      filename,
      lineno: Number(lineno),
      colno: Number(colno),
    });
    if (frames.length >= 30) break;
  }
  return frames.length ? frames : undefined;
}

function rateLimited(): boolean {
  const now = Date.now();
  state.sentAt = state.sentAt.filter((t) => now - t < RATE_WINDOW_MS);
  if (state.sentAt.length >= RATE_LIMIT) return true;
  state.sentAt.push(now);
  return false;
}

function duplicate(level: ReportLevel, kind: string | undefined, code: string | undefined, message: string): boolean {
  const signature = `${level}|${kind ?? ""}|${code ?? ""}|${message}`;
  const now = Date.now();
  for (const [key, at] of state.signatures) {
    if (now - at > DEDUPE_WINDOW_MS) state.signatures.delete(key);
  }
  const last = state.signatures.get(signature);
  state.signatures.set(signature, now);
  return last !== undefined && now - last < DEDUPE_WINDOW_MS;
}

function transportSend(event: RedactedEvent): void {
  ensureInitialized();
  if (!state.transport) return;
  if (state.sampleRate < 1 && Math.random() >= state.sampleRate) return;
  void state.transport.send(event).catch(() => undefined); // reporting must never break the app
}

function emit(
  level: ReportLevel,
  err: unknown,
  message: string,
  ctx: ReportContext | undefined,
  referenceId: string,
): void {
  if (!state.dsn) return;
  if (!getReportingConsent()) {
    if (!hasReportingConsentChoice() && !state.consentPromptShown && consentPromptHandler) {
      state.consentPromptShown = true;
      try {
        consentPromptHandler();
      } catch {
        // A broken prompt must not break reporting setup.
      }
    }
    return;
  }
  if (state.reporting) return; // re-entrancy: an error thrown while reporting
  if (rateLimited()) return;

  const fields = toReportFields(err);
  if (fields.kind === "rejected") return; // a cancelled signature is a choice, not an error
  const rawMessage = redactString(message, { salt: saltFromStorage(), allowlist });
  if (duplicate(level, fields.kind ?? fields.apiCode, fields.code, rawMessage)) return;

  const tags: Record<string, string> = {};
  if (ctx?.feature) tags.feature = ctx.feature;
  if (ctx?.walletModule) tags.wallet_module = String(ctx.walletModule);
  if (err instanceof Error) tags.error_name = err.name;
  if (fields.requestId) tags.request_id = fields.requestId;

  const raw: RedactedEvent = {
    id: referenceId,
    timestamp: new Date().toISOString(),
    release: state.release,
    environment: state.environment,
    route: ctx?.route ?? state.route,
    level,
    kind: fields.kind,
    code: fields.code,
    contract: fields.contract,
    apiCode: fields.apiCode,
    httpStatus: fields.httpStatus,
    walletModule: ctx?.walletModule,
    message: rawMessage,
    stack: err instanceof Error ? parseStack(err.stack) : undefined,
    breadcrumbs: [...state.breadcrumbs],
    tags,
    extra: ctx?.extra,
  };

  const options = { salt: saltFromStorage(), allowlist };
  state.reporting = true;
  try {
    const redacted = redactEvent(raw, options);
    if (!redacted) return; // a JWT or seed survived: drop the event entirely
    const event = JSON.parse(redacted.event) as RedactedEvent;
    if (redacted.containedSecret) event.tags.contained_secret = "true";
    transportSend(event);
  } finally {
    state.reporting = false;
  }
}

/**
 * Captures an error and returns a short reference id to show in the UI
 * ("Reference: K3F9QZ2A"). Always returns an id, even when reporting is
 * disabled — then it is only generated locally (and logged in dev).
 */
export function reportError(err: unknown, ctx?: ReportContext): string {
  const referenceId = newReferenceId();
  const message = err instanceof Error ? err.message : String(err);
  if ((!state.dsn || !getReportingConsent()) && process.env.NODE_ENV !== "production") {
    // Disabled reporting still helps locally.
    try {
      console.error(`[oracledesk] ${referenceId}`, err);
    } catch {
      // console may be unavailable; the reference id still works.
    }
  }
  emit("error", err, message, ctx, referenceId);
  return referenceId;
}

/** Captures a non-error message with the same redaction and consent rules. */
export function reportMessage(level: ReportLevel, message: string, ctx?: ReportContext): string {
  const referenceId = newReferenceId();
  emit(level, null, message, ctx, referenceId);
  return referenceId;
}

/** Exposed for tests: reset mutable reporter state. */
export function __resetReportingForTests(): void {
  state.breadcrumbs = [];
  state.sentAt = [];
  state.signatures = new Map();
  state.reporting = false;
  state.consentPromptShown = false;
  state.transport = null;
  memoryConsent = null;
}
