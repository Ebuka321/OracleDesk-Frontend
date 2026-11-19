/**
 * Untrusted external URLs (backend `marketUrl`/`metaUri`, socket payloads).
 * Only absolute https URLs on an allowlisted host are returned.
 */

const MAX_URL = 2048;

export function safeExternalUrl(value: unknown, allowedHosts: readonly string[]): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((candidate) => {
    const normal = candidate.trim().toLowerCase().replace(/^\*\./, "");
    return normal === host || (candidate.startsWith("*.") && host.endsWith(`.${normal}`));
  });
  return allowed ? url.toString() : null;
}

/** Hostnames of configured endpoints, for `safeExternalUrl` callers. */
export function hostsFrom(urls: ReadonlyArray<string | null | undefined>): string[] {
  const hosts: string[] = [];
  for (const value of urls) {
    if (!value) continue;
    try {
      hosts.push(new URL(value).hostname);
    } catch {
      // Ignore malformed configuration; config validation already reports it.
    }
  }
  return hosts;
}
