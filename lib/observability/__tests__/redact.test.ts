import { describe, expect, it } from "vitest";
import {
  getRedactionSalt,
  hashAddress,
  redactEvent,
  redactString,
  redactStringDetailed,
  redactValue,
  stripUrlDetails,
} from "../redact";

const SALT = "test-salt-0123456789";
const G_ADDRESS = "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ";
const CONTRACT_ID = "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O";
const SECRET_SEED = "S" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".repeat(2).slice(0, 55);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJleHAiOjk5OTk5OTk5OTl9.abc123XYZ";

describe("redaction (Issue #123)", () => {
  it("replaces JWTs", () => {
    const result = redactStringDetailed(`Authorization failed for ${JWT}`, { salt: SALT });
    expect(result.text).toContain("[jwt]");
    expect(result.text).not.toContain("eyJzdWIi");
    expect(result.containedSecret).toBe(false);
  });

  it("replaces a secret seed and tags the event", () => {
    const result = redactStringDetailed(`bad seed ${SECRET_SEED} rejected`, { salt: SALT });
    expect(result.text).toContain("[secret]");
    expect(result.text).not.toContain(SECRET_SEED);
    expect(result.containedSecret).toBe(true);
  });

  it("hashes G addresses deterministically per salt", () => {
    const first = redactString(`holder ${G_ADDRESS}`, { salt: SALT });
    const second = redactString(`holder ${G_ADDRESS}`, { salt: SALT });
    expect(first).toBe(second);
    expect(first).not.toContain(G_ADDRESS);
    expect(first).toMatch(/G:[0-9a-f]{8}/);
    // A different salt must produce a different handle.
    expect(hashAddress(G_ADDRESS, "another-salt")).not.toBe(hashAddress(G_ADDRESS, SALT));
    expect(hashAddress(G_ADDRESS, SALT)).toMatch(/^G:[0-9a-f]{8}$/);
  });

  it("keeps configured contract ids from the allowlist", () => {
    const text = redactString(`route through ${CONTRACT_ID}`, {
      salt: SALT,
      allowlist: new Set([CONTRACT_ID]),
    });
    expect(text).toContain(CONTRACT_ID);
  });

  it("replaces long base64 xdr blobs", () => {
    const xdr = "AAAA".repeat(30); // 120 chars
    const text = redactString(`payload ${xdr} end`, { salt: SALT });
    expect(text).toContain("[xdr:120]");
    expect(text).not.toContain(xdr);
  });

  it("keeps 64-hex transaction hashes unless adjacent to secret wording", () => {
    const hash = "80b9203ba957a755ef573070146aa72a41a8470932f121213e6f8566c7609ca1";
    expect(redactString(`tx ${hash}`, { salt: SALT })).toContain(hash);
    expect(redactString(`seed${hash}`, { salt: SALT })).not.toContain(hash);
  });

  it("drops sensitive keys at any depth", () => {
    const value = redactValue(
      {
        authorization: "Bearer abc",
        nested: { token: "xyz", deeper: { signature: "s", keep: "yes" } },
        ok: "plain",
      },
      { salt: SALT },
    ) as Record<string, unknown>;
    expect(value.authorization).toBeUndefined();
    expect(value.ok).toBe("plain");
    const nested = value.nested as Record<string, unknown>;
    expect(nested.token).toBeUndefined();
    const deeper = nested.deeper as Record<string, unknown>;
    expect(deeper.signature).toBeUndefined();
    expect(deeper.keep).toBe("yes");
  });

  it("strips query strings and fragments from URLs", () => {
    expect(stripUrlDetails("https://host/path?token=abc#frag")).toBe("https://host/path");
    const text = redactString("see https://host/path?jwt=1", { salt: SALT });
    expect(text).toBe("see https://host/path");
  });

  it("final pass drops the event if a pattern survives", () => {
    // A JWT embedded in an object key never passes through string redaction,
    // so the serialized second pass is what stops it.
    const dropped = redactEvent({ tags: { [JWT]: "1" } }, { salt: SALT });
    expect(dropped).toBeNull();
    const kept = redactEvent({ message: `failed ${JWT}` }, { salt: SALT });
    expect(kept).not.toBeNull();
    expect(kept!.event).not.toContain("eyJzdWIi");
  });

  it("handles cyclic objects", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const value = redactValue(cyclic, { salt: SALT }) as Record<string, unknown>;
    expect(value.name).toBe("root");
    expect(value.self).toBe("[circular]");
  });

  it("exposes a stable per-install salt", () => {
    const salt = getRedactionSalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(getRedactionSalt()).toBe(salt);
  });
});
