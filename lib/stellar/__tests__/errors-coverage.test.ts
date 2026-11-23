import { describe, expect, it } from "vitest";
import enCatalog from "@/lib/i18n/messages/en.json";
import { CONTRACT_TABLES } from "@/lib/errors/codes";

describe("Contract Errors Coverage", () => {
  it("every contract error name in every binding has a catalog message", () => {
    const uncovered: { contract: string; code: number; name: string }[] = [];

    for (const [contract, table] of Object.entries(CONTRACT_TABLES)) {
      for (const [codeStr, entry] of Object.entries(table)) {
        const code = Number(codeStr);
        const name = (entry as { message: string }).message;
        const msg = (enCatalog.errors.contract as Record<string, Record<string, string>>)[contract]?.[name];
        if (!msg) {
          uncovered.push({ contract, code, name });
        }
      }
    }

    expect(uncovered).toEqual([]);
  });
});
