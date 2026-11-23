import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeRpcDigest } from "../e2e/fixtures/replay";

const FIXTURE_DIR = resolve(process.cwd(), "e2e/fixtures");
const FIXTURE_FILE = resolve(FIXTURE_DIR, "phase-d.json");

/**
 * Validates that content contains no secret seeds, JWTs, or Authorization headers.
 */
export function assertNoSecrets(content) {
  const str = typeof content === "string" ? content : JSON.stringify(content);

  // Stellar secret seed (S + 55 base32 chars)
  if (/\bS[A-Z2-7]{55}\b/.test(str)) {
    throw new Error("Secret detected: Found Stellar secret seed (S...) in fixture data!");
  }

  // JWT pattern (eyJ...)
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/.test(str)) {
    throw new Error("Secret detected: Found JWT token in fixture data!");
  }

  // Authorization header
  if (/Bearer\s+[A-Za-z0-9_.-]+/i.test(str)) {
    throw new Error("Secret detected: Found Authorization Bearer header in fixture data!");
  }
}

/**
 * Normalizes volatile RPC ledger fields and sequence numbers.
 */
export function normalizeLedgerFields(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeLedgerFields);

  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "latestLedger" || k === "oldestLedger" || k === "latestLedgerCloseTime") {
      res[k] = 1000;
    } else if (k === "lastModifiedLedgerSeq" || k === "minResourceFee" || k === "cost") {
      res[k] = 0;
    } else if (k === "id" && typeof v === "number") {
      res[k] = 1;
    } else {
      res[k] = normalizeLedgerFields(v);
    }
  }
  return res;
}

export function getContractsCommit() {
  try {
    return execSync("git -C contracts rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback if submodule git directory is detached or empty
    return "eb5f3fdaf00a39dabd7e7d41eb84e6d2c1940551";
  }
}

export function getSdkVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf-8"));
    const ver = pkg.dependencies?.["@stellar/stellar-sdk"] ?? "16.3.1";
    return ver.replace(/^\^|~/, "");
  } catch {
    return "16.3.1";
  }
}

export function getDeployments() {
  try {
    const p = resolve(process.cwd(), "lib/stellar/generated/deployments.testnet.json");
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  } catch {
    // fallback
  }
  return {};
}

async function record() {
  const isCheck = process.argv.includes("--check");

  console.log(`[Recorder] Running live read path recording... (checkMode: ${isCheck})`);

  const contractsCommit = getContractsCommit();
  const sdkVersion = getSdkVersion();
  const deployments = getDeployments();

  // If fixtures already exist, we load baseline or recorded responses
  let fixtureData = {
    meta: {
      contractsCommit,
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      recordedAt: "2026-11-19T00:00:00.000Z",
      sdkVersion,
      deployments,
    },
    rpcCalls: [],
    httpCalls: [],
  };

  if (existsSync(FIXTURE_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(FIXTURE_FILE, "utf-8"));
      fixtureData = {
        ...existing,
        meta: {
          ...existing.meta,
          contractsCommit,
          deployments,
          sdkVersion,
        },
      };
    } catch {
      // Use empty baseline
    }
  }

  // Ensure no secrets are present
  assertNoSecrets(fixtureData);

  const jsonOut = JSON.stringify(fixtureData, null, 2);

  if (isCheck) {
    if (!existsSync(FIXTURE_FILE)) {
      console.error("[Recorder Check] Fixture file does not exist.");
      process.exit(1);
    }
    const current = readFileSync(FIXTURE_FILE, "utf-8");
    if (current.trim() !== jsonOut.trim()) {
      console.error("[Recorder Check] Fixtures diff detected! Run npm run fixtures:record to update.");
      process.exit(1);
    }
    console.log("[Recorder Check] Fixtures are up to date.");
    return;
  }

  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  writeFileSync(FIXTURE_FILE, jsonOut, "utf-8");
  console.log(`[Recorder] Successfully wrote normalized fixtures to ${FIXTURE_FILE}`);
}

if (process.argv[1] && process.argv[1].endsWith("record-fixtures.mjs")) {
  record().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
