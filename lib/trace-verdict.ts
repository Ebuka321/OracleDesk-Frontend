import type { TraceVerdict } from "./stellar/generated/reasoning-registry";

/** Maps a contract-side TraceVerdict to a display label/variant for trade attribution UI. Fails closed: anything but Valid shows a warning. */
export function describeVerdict(verdict: TraceVerdict): { label: string; variant: "ok" | "warning"; reason?: string } {
  switch (verdict.tag) {
    case "Valid":
      return { label: "Verified", variant: "ok" };
    case "Flagged":
      return { label: "Flagged", variant: "warning", reason: verdict.values[0] };
    case "HashMismatch":
      return { label: "Hash mismatch", variant: "warning" };
    case "AgentRevokedAfter":
      return { label: "Agent revoked", variant: "warning", reason: `revoked at ledger ${verdict.values[0]}` };
  }
}
