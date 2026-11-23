import { describe, expect, it } from "vitest";
import enCatalog from "@/lib/i18n/messages/en.json";
import {
  API_ERROR_CODES,
  CONTRACT_TABLES,
  DESCRIBED_ERROR_KINDS,
  contractCodes,
} from "../codes";
import { messageFor } from "../messages";

describe("Error Catalog Coverage", () => {
  it("every binding Errors entry in all four generated tables has a catalog message", () => {
    const missing: string[] = [];

    for (const [contractName, table] of Object.entries(CONTRACT_TABLES)) {
      for (const entry of Object.values(table)) {
        const errorName = entry.message;
        const msg = (enCatalog.errors.contract as Record<string, Record<string, string>>)[contractName]?.[errorName];
        if (!msg || typeof msg !== "string" || !msg.trim()) {
          missing.push(`contract.${contractName}.${errorName}`);
        }
      }
    }

    expect(missing, `Missing catalog entries for contract errors: ${missing.join(", ")}`).toEqual([]);
  });

  it("contractCodes() runtime helper returns all binding codes", () => {
    const codes = contractCodes();
    expect(codes.length).toBeGreaterThanOrEqual(53);
    for (const code of codes) {
      const msg = messageFor(code);
      expect(msg).toBeTruthy();
      expect(msg).not.toContain("The contract rejected this");
    }
  });

  it("every API_ERROR_CODES entry has a catalog message", () => {
    const missing: string[] = [];

    for (const code of API_ERROR_CODES) {
      const msg = enCatalog.errors.api[code];
      if (!msg || typeof msg !== "string" || !msg.trim()) {
        missing.push(code);
      }
    }

    expect(missing, `Missing catalog entries for API error codes: ${missing.join(", ")}`).toEqual([]);
  });

  it("every DescribedError kind has a catalog message", () => {
    const missing: string[] = [];

    for (const kind of DESCRIBED_ERROR_KINDS) {
      const msg = enCatalog.errors.kind[kind];
      if (!msg || typeof msg !== "string" || !msg.trim()) {
        missing.push(kind);
      }
    }

    expect(missing, `Missing catalog entries for DescribedError kinds: ${missing.join(", ")}`).toEqual([]);
  });

  it("catalog has no orphan error keys", () => {
    // Kinds
    const expectedKinds = new Set<string>(DESCRIBED_ERROR_KINDS);
    const catalogKinds = Object.keys(enCatalog.errors.kind);
    const orphanKinds = catalogKinds.filter((k) => !expectedKinds.has(k));
    expect(orphanKinds, `Orphan error kinds in catalog: ${orphanKinds.join(", ")}`).toEqual([]);

    // Contracts
    const expectedContracts = new Set<string>(Object.keys(CONTRACT_TABLES));
    const catalogContracts = Object.keys(enCatalog.errors.contract);
    const orphanContracts = catalogContracts.filter((c) => !expectedContracts.has(c));
    expect(orphanContracts, `Orphan contracts in catalog: ${orphanContracts.join(", ")}`).toEqual([]);

    // Per-contract error names
    for (const [contractName, table] of Object.entries(CONTRACT_TABLES)) {
      const validNames = new Set(Object.values(table).map((e) => e.message));
      const catalogNames = Object.keys(
        (enCatalog.errors.contract as Record<string, Record<string, string>>)[contractName] || {},
      );
      const orphanNames = catalogNames.filter((n) => !validNames.has(n));
      expect(
        orphanNames,
        `Orphan errors for ${contractName} in catalog: ${orphanNames.join(", ")}`,
      ).toEqual([]);
    }

    // API error codes
    const expectedApiCodes = new Set<string>(API_ERROR_CODES);
    const catalogApiCodes = Object.keys(enCatalog.errors.api);
    const orphanApiCodes = catalogApiCodes.filter((c) => !expectedApiCodes.has(c));
    expect(orphanApiCodes, `Orphan API error codes in catalog: ${orphanApiCodes.join(", ")}`).toEqual([]);
  });

  it("interpolates ICU plural and single parameters correctly", () => {
    const msg1 = messageFor("api.RATE_LIMITED", { seconds: 1 });
    expect(msg1).toBe("Too many requests. Try again in 1 second.");

    const msg5 = messageFor("api.RATE_LIMITED", { seconds: 5 });
    expect(msg5).toBe("Too many requests. Try again in 5 seconds.");

    const msgNet = messageFor("kind.wrong-network", { network: "Stellar Futurenet" });
    expect(msgNet).toBe("Switch your wallet to Stellar Futurenet and try again.");
  });
});
