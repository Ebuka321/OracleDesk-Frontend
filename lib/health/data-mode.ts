import type { BackendHealth, RpcHealth } from "@/lib/stellar/health";

/**
 * "chain-only" means the backend is confirmed unreachable but the RPC is not,
 * so money paths (markets, positions, trading, redeem) can still be served
 * straight from the chain.
 */
export type DataMode = "full" | "chain-only";

export interface ModeInput {
  backend: BackendHealth;
  rpc: RpcHealth;
  /** Consecutive backend probes that reported `down` (including this one). */
  backendDownStreak: number;
  /** Consecutive backend probes that reported `ok` (including this one). */
  backendOkStreak: number;
  /** `BACKEND_UNREACHABLE` / 5xx API errors seen in the last `API_FAILURE_WINDOW_MS`. */
  apiFailures: number;
}

export const ENTER_DOWN_PROBES = 2;
export const ENTER_API_FAILURES = 3;
export const API_FAILURE_WINDOW_MS = 30_000;
export const EXIT_OK_PROBES = 2;

/**
 * Next data mode with hysteresis: enter chain-only after 2 down probes or 3
 * API failures in the window, leave it only after 2 consecutive ok probes.
 * Never chain-only while the RPC is down (that state is "offline").
 */
export function nextDataMode(prev: DataMode, input: ModeInput): DataMode {
  if (input.rpc.status === "down") return "full";
  if (prev === "chain-only") {
    return input.backend.status === "ok" && input.backendOkStreak >= EXIT_OK_PROBES ? "full" : "chain-only";
  }
  const probeDown = input.backend.status === "down" && input.backendDownStreak >= ENTER_DOWN_PROBES;
  return probeDown || input.apiFailures >= ENTER_API_FAILURES ? "chain-only" : "full";
}
