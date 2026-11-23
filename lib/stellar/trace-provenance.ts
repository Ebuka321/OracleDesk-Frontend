/**
 * Trace publication provenance (#267): checks that the transaction and the
 * `TracePublished` event that published a trace agree with the registry entry.
 * The RPC is trusted for transaction data; this does not prove ledger inclusion.
 */

export type ProvenanceStatus = "confirmed" | "confirmed-by-event" | "outside-retention" | "contradicted" | "unavailable";
export interface ProvenanceCheck { name: string; ok: boolean | null; expected?: string; actual?: string }

/** Registry `get_trace` entry, normalized for comparison. */
export interface RegistryTrace { traceId: bigint; agent: string; marketId: bigint; action: string; traceHashHex: string; ipfsCid: string; publishedAt: bigint }

/** Fields decoded from the publishing transaction's `publish_trace` invocation. */
export interface ObservedInvocation { contractId: string; fn: string; agent: string; marketId: bigint; action: string; traceHashHex: string; ipfsCid: string; returnTraceId: bigint | null; authorizedBy: readonly string[] }

/** Fields decoded from the registry `TracePublished` event. */
export interface ObservedEvent { contractId: string; traceId: bigint; marketId: bigint; agent: string; action: string; traceHashHex: string; ipfsCid: string; publishedAt: bigint; txHash: string }

export interface ProvenanceInput {
  entry: RegistryTrace;
  registryId: string;
  /** Null when `getTransaction` returned NOT_FOUND (outside retention). */
  tx: { hash: string; closeTime: number; invocation: ObservedInvocation | null } | null;
  event: ObservedEvent | null;
  claimedTxHash?: string | null;
  claimedCreatedAt?: string | null;
  /** True when the entry's publish time is older than the RPC retention window. */
  outsideRetention?: boolean;
}

export interface TraceProvenance { traceId: string; status: ProvenanceStatus; txHash: string | null; checks: ProvenanceCheck[]; disagreements: string[] }

const check = (name: string, expected: unknown, actual: unknown): ProvenanceCheck =>
  ({ name, ok: String(expected) === String(actual), expected: String(expected), actual: String(actual) });

export function evaluateProvenance(input: ProvenanceInput): TraceProvenance {
  const { entry, tx, event } = input;
  const checks: ProvenanceCheck[] = [];
  const disagreements: string[] = [];

  if (event) {
    checks.push(check("event contract", input.registryId, event.contractId));
    checks.push(check("event trace id", entry.traceId, event.traceId));
    checks.push(check("event market", entry.marketId, event.marketId));
    checks.push(check("event agent", entry.agent, event.agent));
    checks.push(check("event action", entry.action, event.action));
    checks.push(check("event trace hash", entry.traceHashHex, event.traceHashHex));
    checks.push(check("event ipfs cid", entry.ipfsCid, event.ipfsCid));
    checks.push(check("event published_at", entry.publishedAt, event.publishedAt));
  }

  const inv = tx?.invocation ?? null;
  if (tx) {
    if (!inv) checks.push({ name: "publish_trace invocation", ok: false, expected: "one publish_trace call", actual: "none" });
    else {
      checks.push(check("invoked contract", input.registryId, inv.contractId));
      checks.push(check("invoked function", "publish_trace", inv.fn));
      checks.push(check("arg agent", entry.agent, inv.agent));
      checks.push(check("arg market", entry.marketId, inv.marketId));
      checks.push(check("arg action", entry.action, inv.action));
      checks.push(check("arg trace hash", entry.traceHashHex, inv.traceHashHex));
      checks.push(check("arg ipfs cid", entry.ipfsCid, inv.ipfsCid));
      checks.push(check("return value", entry.traceId, inv.returnTraceId));
      checks.push({ name: "agent authorized", ok: inv.authorizedBy.includes(entry.agent), expected: entry.agent, actual: inv.authorizedBy.join(",") });
    }
    checks.push(check("ledger close time", entry.publishedAt, tx.closeTime));
  }

  const txHash = tx?.hash ?? event?.txHash ?? null;
  if (input.claimedTxHash && txHash && input.claimedTxHash.toLowerCase() !== txHash.toLowerCase()) {
    disagreements.push("backend publishTxHash points at a different transaction");
  }
  if (input.claimedCreatedAt) {
    const claimed = Date.parse(input.claimedCreatedAt) / 1000;
    if (Number.isFinite(claimed) && Math.abs(claimed - Number(entry.publishedAt)) > 120) disagreements.push("backend createdAt differs from the publish time by more than 120 s");
  }

  let status: ProvenanceStatus;
  if (checks.some((c) => c.ok === false)) status = "contradicted";
  else if (tx && inv) status = "confirmed";
  else if (event) status = "confirmed-by-event";
  else status = input.outsideRetention ? "outside-retention" : "unavailable";

  return { traceId: entry.traceId.toString(), status, txHash, checks, disagreements };
}
