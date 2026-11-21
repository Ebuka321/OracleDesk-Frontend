import { rpc, xdr } from "@stellar/stellar-sdk";
import { useSyncExternalStore } from "react";
import {
  checkContractIntegrity,
  contractInstanceLedgerKey,
  type ContractKey,
  type IntegrityResult,
} from "./contract-check";
import { CONTRACTS } from "./config";
import { rpcServer } from "./clients";
import { ledgerClock, type LedgerClock, type LedgerInfo } from "./ledger-clock";
import { invalidateSigningEpoch, rpcNetworkEpoch } from "./rpc-network-guard";

export type MonitorStatus = "initial" | "ok" | "rechecking" | "failed" | "unchecked";

export interface ExecutableChange {
  contract: ContractKey | "usdc";
  from: string;
  to: string;
  atLedger: number;
  specDiff?: string;
}

export interface MonitorSnapshot {
  status: MonitorStatus;
  results: Record<ContractKey | "usdc", IntegrityResult> | null;
  executables: Record<ContractKey | "usdc", string>;
  verifiedAtLedger: number;
  changes: ExecutableChange[];
  epoch: number;
}

export interface IntegrityMonitorDeps {
  server: () => rpc.Server;
  clock: LedgerClock;
  check: typeof checkContractIntegrity;
  onChange?: (changes: ExecutableChange[]) => void;
  everyLedgers?: number;
}

export const INTEGRITY_MAX_AGE_LEDGERS = 12; // ~1 minute at 5s ledger close

const CONTRACT_NAMES: readonly (ContractKey | "usdc")[] = [
  "marketCore",
  "treasury",
  "resolver",
  "reasoningRegistry",
  "usdc",
] as const;

export class IntegrityMonitor {
  private status: MonitorStatus = "initial";
  private results: Record<ContractKey | "usdc", IntegrityResult> | null = null;
  private executables: Record<ContractKey | "usdc", string> = {
    marketCore: "missing",
    treasury: "missing",
    resolver: "missing",
    reasoningRegistry: "missing",
    usdc: "missing",
  };
  private verifiedAtLedger = 0;
  private changes: ExecutableChange[] = [];
  private epoch = 0;
  private lastNetworkEpoch = rpcNetworkEpoch();

  private listeners = new Set<() => void>();
  private unsubscribeClock: (() => void) | null = null;
  private running = false;
  private checking = false;
  private tickCounter = 0;

  constructor(private readonly deps: IntegrityMonitorDeps) {}

  snapshot = (): MonitorSnapshot => {
    return {
      status: this.status,
      results: this.results,
      executables: { ...this.executables },
      verifiedAtLedger: this.verifiedAtLedger,
      changes: [...this.changes],
      epoch: this.epoch,
    };
  };

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify = (): void => {
    this.epoch++;
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        // safe listener dispatch
      }
    });
  };

  start = (): (() => void) => {
    if (this.running) return this.stop;
    this.running = true;

    // Run initial probe & full check
    void this.probe();

    this.unsubscribeClock = this.deps.clock.subscribe((ledger) => {
      if (!this.running) return;

      // Reset baseline if network epoch changed
      const currentNetEpoch = rpcNetworkEpoch();
      if (currentNetEpoch !== this.lastNetworkEpoch) {
        this.lastNetworkEpoch = currentNetEpoch;
        this.status = "initial";
        this.results = null;
        this.executables = {
          marketCore: "missing",
          treasury: "missing",
          resolver: "missing",
          reasoningRegistry: "missing",
          usdc: "missing",
        };
        this.verifiedAtLedger = 0;
        this.notify();
      }

      const isHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const interval = isHidden ? 3 : (this.deps.everyLedgers ?? 1);
      if (++this.tickCounter % interval === 0) {
        void this.probe(ledger?.sequence);
      }
    });

    return this.stop;
  };

  stop = (): void => {
    this.running = false;
    this.unsubscribeClock?.();
    this.unsubscribeClock = null;
  };

  /**
   * Synchronously verifies that the instance executables are fresh.
   * If stale (> maxAgeLedgers), forces a probe immediately before signing.
   */
  ensureFresh = async (
    maxAgeLedgers: number = INTEGRITY_MAX_AGE_LEDGERS,
    signal?: AbortSignal,
  ): Promise<MonitorSnapshot> => {
    if (signal?.aborted) throw new Error("Integrity check aborted");
    const latest = this.deps.clock.getLatest()?.sequence ?? 0;
    if (this.verifiedAtLedger === 0 || latest - this.verifiedAtLedger > maxAgeLedgers) {
      await this.probe(latest);
    }
    return this.snapshot();
  };

  /**
   * Cheap probe: fetches only the 5 instance ledger entries.
   * Compares the decoded executable (wasm hash or SAC) with the last verified baseline.
   */
  async probe(currentLedger?: number): Promise<void> {
    if (this.checking) return;
    this.checking = true;

    try {
      const server = this.deps.server();
      const keysToFetch: { key: xdr.LedgerKey; name: ContractKey | "usdc"; id: string }[] = [];

      for (const name of CONTRACT_NAMES) {
        const id = CONTRACTS[name];
        if (id) {
          try {
            keysToFetch.push({ key: contractInstanceLedgerKey(id), name, id });
          } catch {
            // invalid address handled as missing
          }
        }
      }

      let ledgerResponse: rpc.Api.GetLedgerEntriesResponse;
      try {
        ledgerResponse = await server.getLedgerEntries(...keysToFetch.map((k) => k.key));
      } catch {
        if (this.status === "initial") {
          this.status = "unchecked";
          this.notify();
        }
        return;
      }

      const latestSeq = ledgerResponse.latestLedger || currentLedger || this.verifiedAtLedger;
      const entriesByKey = new Map<string, rpc.Api.LedgerEntryResult>();
      for (const entry of ledgerResponse.entries) {
        entriesByKey.set(entry.key.toXDR("base64"), entry);
      }

      const newExecutables: Record<ContractKey | "usdc", string> = { ...this.executables };
      const changedContracts: { name: ContractKey | "usdc"; from: string; to: string }[] = [];

      for (const item of keysToFetch) {
        const entry = entriesByKey.get(item.key.toXDR("base64"));
        let kind = "missing";

        if (entry) {
          if (entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < latestSeq) {
            kind = "archived";
          } else {
            try {
              const contractData = entry.val.contractData();
              const instance = contractData.val().instance();
              const exec = instance.executable();
              if (exec.switch().name === "contractExecutableWasm") {
                kind = `wasm:${exec.wasmHash().toString("hex")}`;
              } else if (exec.switch().name === "contractExecutableStellarAsset") {
                kind = "sac";
              } else {
                kind = "wrong-kind";
              }
            } catch {
              kind = "missing";
            }
          }
        }

        const oldKind = this.executables[item.name];
        newExecutables[item.name] = kind;

        if (this.status !== "initial" && oldKind !== kind) {
          changedContracts.push({ name: item.name, from: oldKind, to: kind });
        }
      }

      // If initial run or contracts changed: run full specification check
      if (this.status === "initial" || changedContracts.length > 0) {
        if (changedContracts.length > 0) {
          this.status = "rechecking";
          invalidateSigningEpoch();
          this.notify();
        }

        const fullResults = await this.deps.check(server);
        this.results = fullResults;
        this.executables = newExecutables;
        this.verifiedAtLedger = latestSeq;

        const resultsList = Object.values(fullResults);
        const hasFailure = resultsList.some(
          (r) => r.status === "mismatch" || r.status === "not-found" || r.status === "wrong-kind",
        );
        const hasUnchecked = resultsList.some((r) => r.status === "unchecked");

        if (hasFailure) {
          this.status = "failed";
        } else if (hasUnchecked) {
          this.status = "unchecked";
        } else {
          this.status = "ok";
        }

        if (changedContracts.length > 0) {
          const newChanges: ExecutableChange[] = changedContracts.map((c) => ({
            contract: c.name,
            from: c.from,
            to: c.to,
            atLedger: latestSeq,
            specDiff: fullResults[c.name]?.detail,
          }));
          this.changes = [...newChanges, ...this.changes].slice(0, 10);
          this.deps.onChange?.(newChanges);
        }

        this.notify();
      } else {
        // No executable changed, instance storage write only (same code)
        this.verifiedAtLedger = latestSeq;
      }
    } finally {
      this.checking = false;
    }
  }
}

let queryInvalidator: (() => void) | null = null;
export function registerQueryInvalidator(fn: () => void) {
  queryInvalidator = fn;
}

export const integrityMonitor = new IntegrityMonitor({
  server: rpcServer,
  clock: ledgerClock,
  check: checkContractIntegrity,
  onChange: (changes) => {
    queryInvalidator?.();
  },
});

export function useIntegrityMonitor(): MonitorSnapshot {
  return useSyncExternalStore(
    integrityMonitor.subscribe,
    integrityMonitor.snapshot,
    integrityMonitor.snapshot,
  );
}
