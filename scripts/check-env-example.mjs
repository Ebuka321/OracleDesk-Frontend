// Checks that .env.example and the code agree on every NEXT_PUBLIC_* value.
// Run with: npm run check:env
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["app", "lib", "components"];
const SCAN_FILES = ["next.config.ts"];
const IGNORED_DIRS = new Set(["node_modules", ".next", "generated", "contracts", ".git"]);

const ENV_REF = /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g;
const EXAMPLE_LINE = /^([A-Z][A-Z0-9_]*)=/;

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (IGNORED_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path);
  }
  return files;
}

export function collectCodeEnvKeys(root = ROOT) {
  const keys = new Set();
  const files = [
    ...SCAN_DIRS.flatMap((dir) => walk(join(root, dir))),
    ...SCAN_FILES.map((file) => join(root, file)).filter((file) => {
      try { return statSync(file).isFile(); } catch { return false; }
    }),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(ENV_REF)) keys.add(match[1]);
  }
  return keys;
}

export function parseExampleKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = EXAMPLE_LINE.exec(line.trim());
    if (match) keys.add(match[1]);
  }
  return keys;
}

/** Problems for keys that exist on one side only. */
export function compareEnvKeys(codeKeys, exampleKeys) {
  const problems = [];
  for (const key of [...codeKeys].sort()) {
    if (!exampleKeys.has(key)) problems.push(`${key} is read by the code but missing from .env.example`);
  }
  for (const key of [...exampleKeys].sort()) {
    if (String(key).startsWith("NEXT_PUBLIC_") && !codeKeys.has(key)) {
      problems.push(`${key} is in .env.example but never read by the code`);
    }
  }
  return problems;
}

/** Cheap structural checks that do not need the TypeScript validator. */
export function checkExampleValues(text) {
  const problems = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = EXAMPLE_LINE.exec(trimmed);
    if (!match) continue;
    const [, key] = match;
    if (seen.has(key)) problems.push(`${key} is defined more than once`);
    seen.add(key);
    const value = trimmed.slice(key.length + 1).trim();
    if (/^S[A-Z2-7]{55}$/.test(value)) problems.push(`${key} looks like a secret seed`);
    if (value && /^NEXT_PUBLIC_.*URL/.test(key)) {
      try {
        const url = new URL(value.split(",")[0].trim());
        if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
          problems.push(`${key} must use https (http only for localhost)`);
        }
        if (url.username || url.password) problems.push(`${key} must not include credentials`);
      } catch {
        if (key !== "NEXT_PUBLIC_CSP_REPORT_URL") problems.push(`${key} is not a valid URL`);
      }
    }
    if (key === "NEXT_PUBLIC_API_URL" && value && !/\/api\/v1\/?$/.test(value)) {
      problems.push(`${key} must end with /api/v1`);
    }
    if (key === "NEXT_PUBLIC_DAILY_PASS_PRICE_USDC" && value && !/^(\d+)(?:\.\d{1,7})?$/.test(value)) {
      problems.push(`${key} must be a decimal USDC amount`);
    }
  }
  return problems;
}

function main() {
  const examplePath = join(ROOT, ".env.example");
  const example = readFileSync(examplePath, "utf8");
  const problems = [
    ...compareEnvKeys(collectCodeEnvKeys(), parseExampleKeys(example)),
    ...checkExampleValues(example),
  ];
  if (problems.length) {
    console.error(`.env.example does not match the code (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`.env.example documents all ${parseExampleKeys(example).size} NEXT_PUBLIC_* variables.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
