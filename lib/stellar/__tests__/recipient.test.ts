import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { checkRecipient } from "../recipient";

const from = Keypair.random().publicKey();
const to = Keypair.random().publicKey();
const protocol = StrKey.encodeContract(Buffer.alloc(32, 7));
const otherContract = StrKey.encodeContract(Buffer.alloc(32, 9));
const deps = (exists = true) => ({ protocolContracts: [protocol], accountExists: async () => exists });

describe("checkRecipient", () => {
  it("rejects invalid, muxed, self, protocol and unfunded recipients", async () => {
    expect(await checkRecipient("not-an-address", from, [], deps())).toEqual({ ok: false, reason: "invalid" });
    expect(await checkRecipient("M" + to.slice(1), from, [], deps())).toEqual({ ok: false, reason: "muxed" });
    expect(await checkRecipient(from, from, [], deps())).toEqual({ ok: false, reason: "self" });
    expect(await checkRecipient(protocol, from, [], deps())).toEqual({ ok: false, reason: "protocol-contract" });
    expect(await checkRecipient(to, from, [], deps(false))).toEqual({ ok: false, reason: "unfunded-account" });
  });

  it("warns for first-time, look-alike and contract recipients", async () => {
    const look = to.slice(0, 4) + "X".repeat(to.length - 8) + to.slice(-4);
    const res = await checkRecipient(to, from, [look], deps());
    expect(res).toMatchObject({ ok: true, kind: "account", warnings: ["first-time", "lookalike"] });
    expect(await checkRecipient(to, from, [to], deps())).toMatchObject({ ok: true, warnings: [] });
    expect(await checkRecipient(otherContract, from, [], deps())).toMatchObject({ ok: true, kind: "contract", warnings: ["first-time", "contract-recipient"] });
  });
});
