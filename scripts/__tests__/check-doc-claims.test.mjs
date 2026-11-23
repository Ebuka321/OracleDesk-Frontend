// Run with: node --test scripts/__tests__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocClaims } from "../check-doc-claims.mjs";

test("reports missing npm scripts, missing script files and unlisted scripts", () => {
  const root = mkdtempSync(join(tmpdir(), "od-docs-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/ok.mjs"), "");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: "eslint", extra: "x" } }));
    writeFileSync(join(root, "README.md"), "`npm run lint`\n`npm run gone`\n`node scripts/ok.mjs` `node scripts/missing.mjs`\n");
    assert.deepEqual(checkDocClaims(root, ["README.md"]), [
      'README.md:2 npm script "gone" does not exist',
      "README.md:3 scripts/missing.mjs does not exist",
      'README.md: script "extra" is missing from the scripts table',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
