type Listener = (message: string) => void;

const listeners = new Set<Listener>();
let latest = "";
let latestTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnnouncedAt = 0;
let lastMessage = "";

export function announceRouteStatus(message: string): void {
  const now = Date.now();
  latest = message;
  if (latestTimer) clearTimeout(latestTimer);

  latestTimer = setTimeout(() => {
    latestTimer = null;
    if (!latest || (latest === lastMessage && now - lastAnnouncedAt < 1_000)) return;
    if (now - lastAnnouncedAt < 750) {
      latestTimer = setTimeout(() => announceRouteStatus(latest), 750 - (now - lastAnnouncedAt));
      return;
    }
    lastMessage = latest;
    lastAnnouncedAt = Date.now();
    listeners.forEach((listener) => listener(latest));
  }, 0);
}

export function subscribeRouteStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetRouteStatusForTests(): void {
  if (latestTimer) clearTimeout(latestTimer);
  latestTimer = null;
  latest = "";
  lastAnnouncedAt = 0;
  lastMessage = "";
  listeners.clear();
}
