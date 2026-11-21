import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { federationServerOf, parseFederationName, resolveFederation } from "../federation";

const account = Keypair.random().publicKey();
const toml = 'FEDERATION_SERVER="https://fed.example.com/federation"\n';

function fakeFetch(body: unknown) {
  return vi.fn(async (url: string) => url.endsWith("stellar.toml")
    ? new Response(toml)
    : Response.json(body)) as unknown as typeof fetch;
}

describe("SEP-2 federation (#268)", () => {
  it("parses names on the last * and rejects IP literals", () => {
    expect(parseFederationName("bob@mail.com*Example.com")).toEqual({ user: "bob@mail.com", domain: "example.com" });
    expect(parseFederationName("a*b*example.com")).toEqual({ user: "a*b", domain: "example.com" });
    expect(parseFederationName("bob*127.0.0.1")).toBeNull();
    expect(parseFederationName("no-separator")).toBeNull();
  });

  it("accepts only an https federation server on the same domain", () => {
    expect(federationServerOf(toml, "example.com")).toBe("https://fed.example.com/federation");
    expect(federationServerOf('FEDERATION_SERVER="http://example.com/f"', "example.com")).toBeNull();
    expect(federationServerOf('FEDERATION_SERVER="https://evil.com/f"', "example.com")).toBeNull();
  });

  it("resolves a G account and rejects a mismatched name or contract id", async () => {
    await expect(resolveFederation("bob*example.com", { fetch: fakeFetch({ stellar_address: "bob*example.com", account_id: account }) }))
      .resolves.toMatchObject({ accountId: account, domain: "example.com" });
    await expect(resolveFederation("bob*example.com", { fetch: fakeFetch({ stellar_address: "eve*example.com", account_id: account }) }))
      .rejects.toMatchObject({ code: "name-mismatch" });
    await expect(resolveFederation("bob*example.com", { fetch: fakeFetch({ stellar_address: "bob*example.com", account_id: "C".padEnd(56, "A") }) }))
      .rejects.toMatchObject({ code: "bad-response" });
  });
});
