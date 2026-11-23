import { getStoredSessionId, getStoredSessionWallet, getStoredToken, onAuthSessionChanged, onTokenRotated, SESSION_MODE } from "./client";
import { refreshSession } from "./auth";
import { refreshDueAt, timingOf } from "./jwt-manager";

/**
 * Proactive bearer-token refresh (issue #269). One tab holds a Web Lock and
 * refreshes before `exp`; other tabs queue on the lock and take over when the
 * leader closes. Followers pick up the new token from `localStorage` at send time.
 */
export function startRefreshScheduler(lockName = "oracledesk-auth-refresh"): () => void {
  if (SESSION_MODE === "cookie" || typeof window === "undefined") return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;

  const arm = () => {
    clearTimeout(timer);
    if (stopped) return;
    const token = getStoredToken();
    const wallet = getStoredSessionWallet();
    const sessionId = getStoredSessionId();
    const timing = token ? timingOf(token, Date.now()) : null;
    if (!token || !wallet || !sessionId || !timing) return;
    const delay = Math.max(0, refreshDueAt(timing) - Date.now());
    timer = setTimeout(() => {
      void refreshSession({ token, wallet, sessionId }).catch(() => undefined);
    }, delay);
  };

  const lead = () => {
    arm();
    const offRotated = onTokenRotated(arm);
    const offSession = onAuthSessionChanged(arm);
    return new Promise<void>((resolve) => {
      release = () => { offRotated(); offSession(); clearTimeout(timer); resolve(); };
    });
  };

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks?.request) void locks.request(lockName, () => (stopped ? undefined : lead())).catch(() => undefined);
  else void lead();

  return () => { stopped = true; clearTimeout(timer); release?.(); };
}
