import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "../client";
import { CopyTradeInitSchema, rawAmount, u64Id } from "../schemas";

const wallet = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const init = {
  copyTradeId: "copy-1",
  transactionPayload: { contractId: wallet, onChainMarketId: "7", outcome: "Yes", collateralInRaw: "10000000", userWallet: wallet, traceReference: null },
  instructions: "sign",
};

describe("response schemas", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("rejects malformed raw amounts and ids, including JSON numbers", () => {
    for (const bad of ["1e9", "-1", " 1", 10, ""]) expect(rawAmount.safeParse(bad).success).toBe(false);
    expect(u64Id.safeParse((1n << 64n).toString()).success).toBe(false);
    expect(u64Id.safeParse("18446744073709551615").success).toBe(true);
  });

  it("throws INVALID_RESPONSE when a strict copy-trade payload has a numeric amount", async () => {
    const bad = { ...init, transactionPayload: { ...init.transactionPayload, collateralInRaw: 10000000 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: bad })));
    await expect(apiClient.post("/trade/copy", {}, undefined, { schema: CopyTradeInitSchema }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("throws INVALID_RESPONSE for a non-JSON 2xx body and strips unknown keys on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(apiClient.post("/trade/copy", {}, undefined, { schema: CopyTradeInitSchema }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { ...init, extra: "x" } })));
    const { data } = await apiClient.post("/trade/copy", {}, undefined, { schema: CopyTradeInitSchema });
    expect(data).not.toHaveProperty("extra");
    expect(data.transactionPayload.onChainMarketId).toBe("7");
  });
});
