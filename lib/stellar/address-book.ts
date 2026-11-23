import deployments from "./generated/deployments.testnet.json";
import { CONTRACTS, KNOWN_AGENTS, NETWORK_LABEL, PAYMENTS_RECIPIENT } from "./config";
import type { KnownAddress } from "./address-policy";

export const ADDRESS_BOOK_CAP = 500;

export interface BookEntry {
  address: string;
  label: string;
  addedAt: number;
  source: "book";
}

export function addressBookKey(wallet: string | null | undefined, network = NETWORK_LABEL): string {
  return `oracledesk:addressbook:v1:${network}:${wallet || "anon"}`;
}

export function loadBook(wallet: string | null | undefined, network = NETWORK_LABEL): BookEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(addressBookKey(wallet, network));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is BookEntry =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof item.address === "string" &&
        typeof item.label === "string" &&
        typeof item.addedAt === "number",
    );
  } catch {
    return [];
  }
}

function saveBook(wallet: string | null | undefined, entries: BookEntry[], network = NETWORK_LABEL): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(addressBookKey(wallet, network), JSON.stringify(entries));
  } catch {
    // Ignore storage quota errors
  }
}

export function addToBook(
  wallet: string | null | undefined,
  entry: { address: string; label: string; addedAt?: number },
  network = NETWORK_LABEL,
): BookEntry[] {
  const existing = loadBook(wallet, network).filter((e) => e.address !== entry.address);
  const next: BookEntry[] = [
    ...existing,
    {
      address: entry.address,
      label: entry.label.trim() || "Saved address",
      addedAt: entry.addedAt ?? Date.now(),
      source: "book" as const,
    },
  ];
  const capped = next.length > ADDRESS_BOOK_CAP ? next.slice(next.length - ADDRESS_BOOK_CAP) : next;
  saveBook(wallet, capped, network);
  return capped;
}

export function removeFromBook(
  wallet: string | null | undefined,
  address: string,
  network = NETWORK_LABEL,
): BookEntry[] {
  const next = loadBook(wallet, network).filter((e) => e.address !== address);
  saveBook(wallet, next, network);
  return next;
}

export function subscribeBook(
  wallet: string | null | undefined,
  onChange: () => void,
  network = NETWORK_LABEL,
): () => void {
  if (typeof window === "undefined") return () => {};
  const key = addressBookKey(wallet, network);
  const handler = (e: StorageEvent) => {
    if (e.key === null || e.key === key) onChange();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/**
 * Merges the user's own wallet, confirmed local book, built-in config/deployments,
 * and optional registry agents into a deduplicated KnownAddress list.
 */
export function knownAddresses(
  wallet: string | null | undefined,
  extraRegistry: readonly KnownAddress[] = [],
  network = NETWORK_LABEL,
): KnownAddress[] {
  const byAddr = new Map<string, KnownAddress>();
  const put = (item: KnownAddress) => {
    if (!item.address) return;
    if (!byAddr.has(item.address)) {
      byAddr.set(item.address, item);
    }
  };

  if (wallet) {
    put({ address: wallet, label: "My Wallet", source: "self" });
  }
  for (const entry of loadBook(wallet, network)) {
    put({ address: entry.address, label: entry.label, source: "book" });
  }
  for (const entry of extraRegistry) {
    put(entry);
  }
  for (const agent of KNOWN_AGENTS) {
    put({ address: agent, label: "Known Agent", source: "config" });
  }
  if (PAYMENTS_RECIPIENT) {
    put({ address: PAYMENTS_RECIPIENT, label: "Payments Recipient", source: "config" });
  }
  for (const [name, id] of Object.entries(CONTRACTS)) {
    if (id) put({ address: id, label: `Contract (${name})`, source: "config" });
  }
  if (deployments.deployer) {
    put({ address: deployments.deployer, label: "Deployer", source: "deployment" });
  }
  if (deployments.agent) {
    put({ address: deployments.agent, label: "Treasury Agent", source: "deployment" });
  }

  return [...byAddr.values()];
}
