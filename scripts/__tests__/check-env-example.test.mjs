// Run with: node --test scripts/__tests__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkExampleValues,
  collectCodeEnvKeys,
  compareEnvKeys,
  parseExampleKeys,
} from "../check-env-example.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "od-env-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test("collects NEXT_PUBLIC_* references from app/, lib/, components/ and next.config.ts", () => {
  const root = fixture({
    "app/page.tsx": "const a = process.env.NEXT_PUBLIC_API_URL;",
    "lib/a.ts": "const b = process.env.NEXT_PUBLIC_RPC_URL;",
    "components/a.tsx": "const c = process.env.NEXT_PUBLIC_FLAG;",
    "next.config.ts": "const d = process.env.NEXT_PUBLIC_CSP_ENFORCE;",
    "lib/stellar/generated/x.ts": "const ignored = process.env.NEXT_PUBLIC_IGNORED;",
  });
  try {
    assert.deepEqual([...collectCodeEnvKeys(root)].sort(), [
      "NEXT_PUBLIC_API_URL",
      "NEXT_PUBLIC_CSP_ENFORCE",
      "NEXT_PUBLIC_FLAG",
      "NEXT_PUBLIC_RPC_URL",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports variables missing on either side", () => {
  const problems = compareEnvKeys(
    new Set(["NEXT_PUBLIC_A", "NEXT_PUBLIC_B"]),
    parseExampleKeys("NEXT_PUBLIC_A=\nNEXT_PUBLIC_C=\n"),
  );
  assert.deepEqual(problems, [
    "NEXT_PUBLIC_B is read by the code but missing from .env.example",
    "NEXT_PUBLIC_C is in .env.example but never read by the code",
  ]);
});

test("flags bad example values", () => {
  const problems = checkExampleValues([
    "NEXT_PUBLIC_API_URL=http://api.example.com/api/v1",
    "NEXT_PUBLIC_STELLAR_RPC_URL=ftp://rpc.example.com",
    "NEXT_PUBLIC_DAILY_PASS_PRICE_USDC=lots",
    "NEXT_PUBLIC_X402_URL=",
    "NEXT_PUBLIC_MARKET_CORE_CONTRACT_ID=SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ].join("\n"));
  assert.ok(problems.some((p) => p.includes("NEXT_PUBLIC_API_URL must use https")));
  assert.ok(problems.some((p) => p.includes("NEXT_PUBLIC_STELLAR_RPC_URL must use https")));
  assert.ok(problems.some((p) => p.includes("NEXT_PUBLIC_DAILY_PASS_PRICE_USDC must be a decimal")));
  assert.ok(problems.some((p) => p.includes("looks like a secret seed")));
});

test("accepts the repository's .env.example", () => {
  const text = readExample();
  assert.deepEqual(checkExampleValues(text), []);
});

function readExample() {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.example"), "utf8");
}
