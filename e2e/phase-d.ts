import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { fetchOnChainMarket } from "../lib/hooks/useStellar";
import { marketCore, reasoningRegistry, Outcomes } from "../lib/stellar/clients";
import { fetchAndVerifyTrace, verifyTraceHash } from "../lib/stellar/trace";

const simulatedValue = <T,>(tx: { result: unknown }): T => {
  const r = tx.result as { unwrap?: () => T };
  return (typeof r?.unwrap === "function" ? r.unwrap() : r) as T;
};

export async function checkJoin(apiUrl: string) {
  const res = await fetch(`${apiUrl}/markets?status=RESOLVED&onChain=true`);
  const body = await res.json();
  expect(body.ok).toBe(true);
  const linked = body.data.filter((m: { onChainMarketId: string | null }) => m.onChainMarketId !== null);
  expect(linked.length).toBeGreaterThan(0);
  for (const m of linked) {
    expect(typeof m.onChainMarketId).toBe("string");
    const view = await fetchOnChainMarket(m.onChainMarketId);
    expect(view.market.category.tag).toBe(m.contractCategory);
  }
}

export async function checkPrice(marketId: bigint | string, expectedYesBps?: number | bigint) {
  const idStr = String(marketId);
  const view = await fetchOnChainMarket(idStr);
  const getPrice = simulatedValue<number>(
    await marketCore().get_price({ market_id: BigInt(idStr), outcome: Outcomes.Yes })
  );
  expect(view.yesBps).toBe(getPrice);
  if (expectedYesBps !== undefined) {
    expect(view.yesBps).toBe(Number(expectedYesBps));
  }
}

export async function checkDemoTrace(
  demoTraceFile?: string,
  demoTraceId: bigint | string = "1",
  demoTraceBytes?: Uint8Array
) {
  const traceId = BigInt(demoTraceId);
  const trace = simulatedValue<{ trace_hash: Uint8Array; ipfs_cid: string }>(
    await reasoningRegistry().get_trace({ trace_id: traceId })
  );
  const onChainHash = Array.from(trace.trace_hash, (b) => b.toString(16).padStart(2, "0")).join("");

  const bytes = demoTraceBytes ?? (demoTraceFile ? new Uint8Array(readFileSync(demoTraceFile)) : new Uint8Array());
  if (bytes.length === 0) return;

  const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace("demo run", "demo rum"));

  expect(await verifyTraceHash(bytes, onChainHash)).toBe(true);
  expect(await verifyTraceHash(tampered, onChainHash)).toBe(false);

  const serve = (b: Uint8Array) => (async () => new Response(b as BodyInit)) as typeof fetch;
  expect((await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash, serve(bytes))).status).toBe("verified");
  expect((await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash, serve(tampered))).status).toBe("mismatch");

  const live = await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash);
  expect(live.status).toBe("unavailable");
}
