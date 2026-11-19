import { describe, expect, it } from "vitest";
import { buildCsp, originOf, socketOriginOf } from "../csp";

const base = {
  apiUrl: "https://api.example.com/api/v1",
  rpcUrl: "https://soroban-testnet.stellar.org",
  ipfsGateway: "https://ipfs.io/ipfs",
  x402Url: "",
  dev: false,
};

function directive(policy: string, name: string): string {
  const found = policy.split("; ").find((part) => part === name || part.startsWith(`${name} `));
  return found ?? "";
}

describe("buildCsp", () => {
  it("builds connect-src from the configured origins", () => {
    const policy = buildCsp(base);
    const connect = directive(policy, "connect-src");
    expect(connect).toContain("'self'");
    expect(connect).toContain("https://api.example.com");
    expect(connect).toContain("https://soroban-testnet.stellar.org");
    expect(connect).toContain("https://ipfs.io");
  });

  it("skips an empty x402 URL instead of emitting an empty source", () => {
    const policy = buildCsp(base);
    expect(directive(policy, "connect-src")).not.toMatch(/\s{2,}/);
    expect(directive(policy, "connect-src")).not.toContain("''");
  });

  it("derives wss from an https API origin and ws from http", () => {
    expect(socketOriginOf("https://api.example.com/api/v1")).toBe("wss://api.example.com");
    expect(socketOriginOf("http://localhost:8000/api/v1")).toBe("ws://localhost:8000");
    expect(directive(buildCsp(base), "connect-src")).toContain("wss://api.example.com");
  });

  it("never emits unsafe-inline in script-src", () => {
    const policy = buildCsp(base);
    expect(directive(policy, "script-src")).not.toContain("unsafe-inline");
    expect(directive(policy, "script-src")).toContain("'strict-dynamic'");
  });

  it("adds unsafe-eval only in development", () => {
    expect(directive(buildCsp({ ...base, dev: true }), "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildCsp(base), "script-src")).not.toContain("'unsafe-eval'");
  });

  it("locks framing down", () => {
    const policy = buildCsp(base);
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'");
  });

  it("adds upgrade-insecure-requests and HSTS-ready policy in production only", () => {
    expect(directive(buildCsp(base), "upgrade-insecure-requests")).toBe("upgrade-insecure-requests");
    expect(directive(buildCsp({ ...base, dev: true }), "upgrade-insecure-requests")).toBe("");
  });

  it("adds report directives when a collector is configured", () => {
    const policy = buildCsp({ ...base, reportUri: "https://csp.example.com/report" });
    expect(policy).toContain("report-uri https://csp.example.com/report");
    expect(policy).toContain("report-to csp-endpoint");
    expect(buildCsp(base)).not.toContain("report-uri");
  });

  it("supports nonces and script hashes", () => {
    const policy = buildCsp({ ...base, nonce: "abc123", scriptHashes: ["'sha256-xyz='"] });
    expect(directive(policy, "script-src")).toContain("'nonce-abc123'");
    expect(directive(policy, "script-src")).toContain("'sha256-xyz='");
  });

  it("originOf returns null for empty or invalid values", () => {
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf("https://example.com/path?q=1")).toBe("https://example.com");
  });
});
