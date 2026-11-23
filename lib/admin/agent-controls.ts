/**
 * Agent kill-switch state model (#264). Mirrors the backend's agent-controls
 * service: one row per scope, an agent's effective state is its own row OR the
 * ALL row, and expired timed pauses are ignored.
 */

export const SCOPES = ["ALL", "MARKET_MAKER", "TRADER"] as const;
export type Scope = (typeof SCOPES)[number];

export interface ControlRow {
  paused: boolean;
  reason: string | null;
  source: string | null;
  until: Date | null;
  by: string | null;
  version: number;
}

export interface AgentControlEvent {
  id: string;
  scope: Scope;
  action: string;
  reason: string | null;
  source: string;
  actor: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface ControlsOverview {
  scopes: { scope: Scope; paused: boolean; own: ControlRow | null }[];
  events: AgentControlEvent[];
}

export interface ScopeView {
  scope: Scope;
  effectivePaused: boolean;
  inheritedFrom: "ALL" | null;
  own: ControlRow | null;
}

export interface AgentControlSocketEvent {
  scope: Scope;
  paused: boolean;
  reason: string | null;
  until: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isScope = (v: unknown): v is Scope => typeof v === "string" && (SCOPES as readonly string[]).includes(v);
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
const dateOrNull = (v: unknown) => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t) : null;
};

function parseRow(v: unknown): ControlRow | null {
  if (!isObject(v) || typeof v.paused !== "boolean") return null;
  return {
    paused: v.paused,
    reason: strOrNull(v.reason),
    source: strOrNull(v.source),
    until: dateOrNull(v.pausedUntil ?? v.until),
    by: strOrNull(v.pausedBy ?? v.by),
    version: typeof v.version === "number" ? v.version : 0,
  };
}

/** Parse `GET /admin/agents/controls`. Returns null for an unexpected shape. */
export function parseControlsOverview(v: unknown): ControlsOverview | null {
  if (!isObject(v) || !Array.isArray(v.scopes) || !Array.isArray(v.events)) return null;
  const scopes: ControlsOverview["scopes"] = [];
  for (const s of v.scopes) {
    if (!isObject(s) || !isScope(s.scope) || typeof s.paused !== "boolean") return null;
    scopes.push({ scope: s.scope, paused: s.paused, own: parseRow(s.own) });
  }
  const events: AgentControlEvent[] = [];
  for (const e of v.events) {
    if (!isObject(e) || !isScope(e.scope)) continue;
    const createdAt = dateOrNull(e.createdAt);
    if (!createdAt) continue;
    events.push({
      id: String(e.id ?? ""),
      scope: e.scope,
      action: String(e.action ?? ""),
      reason: strOrNull(e.reason),
      source: String(e.source ?? ""),
      actor: strOrNull(e.actor),
      before: e.before,
      after: e.after,
      createdAt,
    });
  }
  return { scopes, events };
}

export function isAgentControlSocketEvent(v: unknown): v is AgentControlSocketEvent {
  return isObject(v) && isScope(v.scope) && typeof v.paused === "boolean" &&
    (v.reason === null || v.reason === undefined || typeof v.reason === "string") &&
    (v.until === null || v.until === undefined || (typeof v.until === "string" && Number.isFinite(Date.parse(v.until))));
}

const rowActive = (row: ControlRow | null, now: Date) => !!row?.paused && (!row.until || row.until.getTime() > now.getTime());

/** Effective state per scope, explaining whether a pause is own or inherited from ALL. */
export function explain(overview: ControlsOverview, now: Date): ScopeView[] {
  const all = overview.scopes.find((s) => s.scope === "ALL")?.own ?? null;
  const allActive = rowActive(all, now);
  return SCOPES.map((scope) => {
    const own = overview.scopes.find((s) => s.scope === scope)?.own ?? null;
    const ownActive = rowActive(own, now);
    const inherited = scope !== "ALL" && !ownActive && allActive;
    return { scope, effectivePaused: ownActive || (scope !== "ALL" && allActive), inheritedFrom: inherited ? "ALL" : null, own };
  });
}

/** Detect the backend's silent no-op: a pause that is not longer than the current one returns 200 unchanged. */
export function pauseOutcome(before: ControlsOverview, after: ControlsOverview, scope: Scope): "applied" | "no-op-longer-exists" | "unknown" {
  const b = before.scopes.find((s) => s.scope === scope)?.own ?? null;
  const a = after.scopes.find((s) => s.scope === scope)?.own ?? null;
  if (!a) return "unknown";
  if (!b) return a.paused ? "applied" : "unknown";
  if (a.version !== b.version || a.until?.getTime() !== b.until?.getTime()) return a.paused ? "applied" : "unknown";
  return b.paused ? "no-op-longer-exists" : "unknown";
}

/** Apply an `AGENT_CONTROL_CHANGED` socket event optimistically; a refetch replaces it with server state. */
export function applySocketEvent(view: ControlsOverview, e: AgentControlSocketEvent): ControlsOverview {
  const until = e.until ? new Date(e.until) : null;
  return {
    ...view,
    scopes: view.scopes.map((s) =>
      s.scope !== e.scope
        ? s
        : { ...s, paused: e.paused, own: { reason: e.reason, source: s.own?.source ?? null, by: s.own?.by ?? null, version: s.own?.version ?? 0, paused: e.paused, until } },
    ),
  };
}

export interface PauseInput { reason: string; until?: Date }

/** Client-side check matching the backend's 5–500 char reason and future-expiry rules. */
export function validatePause(input: PauseInput, now: Date): string | null {
  const len = input.reason.trim().length;
  if (len < 5 || len > 500) return "Reason must be between 5 and 500 characters.";
  if (input.until && input.until.getTime() <= now.getTime()) return "Expiry must be in the future.";
  return null;
}
