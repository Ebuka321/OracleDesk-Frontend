/**
 * Client-side JWT timing for proactive refresh (issue #269).
 * Tokens are decoded without verification; only `iat`/`exp` are used.
 */

interface JWTPayload {
  exp: number;
  iat: number;
  [key: string]: unknown;
}

/**
 * Decode JWT payload without verification (client-side only).
 * Does not validate signature; use on decoded tokens only.
 */
export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null;
  }
}

export interface TokenTiming { iat: number; exp: number; skewMs: number }

/** Server-vs-device clock skew taken from `iat` at the moment the token arrived. */
export function timingOf(token: string, receivedAtMs: number): TokenTiming | null {
  const payload = decodeJWT(token);
  if (!payload || typeof payload.iat !== "number" || typeof payload.exp !== "number") return null;
  return { iat: payload.iat, exp: payload.exp, skewMs: payload.iat * 1000 - receivedAtMs };
}

/**
 * Device-clock ms at which to refresh: 80% of the lifetime, but no later than
 * `exp - 10 min` and no sooner than 60 s after `iat`.
 */
export function refreshDueAt(t: TokenTiming): number {
  const serverSeconds = Math.max(t.iat + 60, Math.min(t.iat + 0.8 * (t.exp - t.iat), t.exp - 600));
  return serverSeconds * 1000 - t.skewMs;
}
