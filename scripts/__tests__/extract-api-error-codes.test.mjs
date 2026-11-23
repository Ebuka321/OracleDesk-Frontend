import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkApiErrorCodes } from "../extract-api-error-codes.mjs";

describe("check:api-errors script", () => {
  it("fails when a new code is added to docs/api.md without updating codes.ts", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-err-test-"));
    const fixtureDoc = path.join(tmpDir, "api.md");
    const fixtureSource = path.join(tmpDir, "codes.ts");

    fs.writeFileSync(
      fixtureDoc,
      "Errors: `400 INVALID_ADDRESS`, `429 RATE_LIMITED`, `400 NEW_UNKNOWN_CODE`\n",
    );

    fs.writeFileSync(
      fixtureSource,
      'export const API_ERROR_CODES = ["INVALID_ADDRESS", "RATE_LIMITED", "TRACE_LOCKED", "BACKEND_UNREACHABLE", "HTTP_UNKNOWN"] as const;\n',
    );

    const result = checkApiErrorCodes(fixtureDoc, fixtureSource);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingInSource, ["NEW_UNKNOWN_CODE"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails when API_ERROR_CODES has a code not present in docs/api.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "api-err-test-"));
    const fixtureDoc = path.join(tmpDir, "api.md");
    const fixtureSource = path.join(tmpDir, "codes.ts");

    fs.writeFileSync(
      fixtureDoc,
      "Errors: `400 INVALID_ADDRESS`\n",
    );

    fs.writeFileSync(
      fixtureSource,
      'export const API_ERROR_CODES = ["INVALID_ADDRESS", "ORPHAN_CODE", "TRACE_LOCKED", "BACKEND_UNREACHABLE", "HTTP_UNKNOWN"] as const;\n',
    );

    const result = checkApiErrorCodes(fixtureDoc, fixtureSource);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingInDoc, ["ORPHAN_CODE"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
