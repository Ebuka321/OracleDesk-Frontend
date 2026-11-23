import { describe, expect, it } from "vitest";
import {
  configuredOrigins,
  findFindings,
  normalizeEscapes,
  parseAllowlist,
} from "../lib/external-origins.mjs";

const allowed = configuredOrigins({} as NodeJS.ProcessEnv);

describe("external origin scanner", () => {
  it("flags a link to fonts.googleapis.com", () => {
    const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined">';
    const findings = findFindings(html, { allowedOrigins: allowed });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ origin: "https://fonts.googleapis.com", kind: "error", context: "fetch-like" });
  });

  it("flags an img src on an unknown host", () => {
    const html = '<img src="https://lh3.googleusercontent.com/aida-public/abc" alt="">';
    const findings = findFindings(html, { allowedOrigins: allowed });
    expect(findings[0]).toMatchObject({ origin: "https://lh3.googleusercontent.com", kind: "error" });
  });

  it("allows configured api and rpc origins", () => {
    const code = 'fetch("http://localhost:8000/api/v1/markets"); rpc("https://soroban-testnet.stellar.org");';
    expect(findFindings(code, { allowedOrigins: allowed })).toEqual([]);
  });

  it("warns on plain string literals unless strict", () => {
    const code = 'const docs = "https://example.invalid/guide";';
    expect(findFindings(code, { allowedOrigins: allowed })[0].kind).toBe("warning");
    expect(findFindings(code, { allowedOrigins: allowed, strict: true })[0].kind).toBe("error");
  });

  it("allows reviewed namespace strings", () => {
    const svg = 'xmlns="http://www.w3.org/2000/svg"';
    const allowlist = parseAllowlist([{ origin: "http://www.w3.org", reason: "XML namespace" }]);
    expect(findFindings(svg, { allowedOrigins: allowed, allowlist })).toEqual([]);
  });

  it("handles escaped urls in rsc payloads", () => {
    const text = normalizeEscapes('"https:\\/\\/evil.example\\/x.js"');
    const findings = findFindings(text, { allowedOrigins: allowed });
    expect(findings[0].origin).toBe("https://evil.example");
  });

  it("requires a reason for every allowlist entry", () => {
    expect(() => parseAllowlist([{ origin: "https://example.com" }])).toThrow(/reason/);
  });
});
