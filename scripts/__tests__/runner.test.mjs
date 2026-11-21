import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));

describe("scripts/__tests__ runner glob", () => {
  it("matches at least 2 .test.mjs files so an empty glob cannot silently pass", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".test.mjs"));
    assert.ok(files.length >= 2, `Expected >= 2 .test.mjs files in ${DIR}, found ${files.length}`);
    assert.ok(files.includes("build-sw-manifest.test.mjs"));
    assert.ok(files.includes("check-doc-claims.test.mjs"));
  });
});
