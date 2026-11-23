#!/usr/bin/env node
/**
 * Verifies that CI job names and check commands claimed in CONTRIBUTING.md
 * and docs/architecture.md match .github/workflows/ci.yml.
 *
 * Usage: node scripts/check-ci-claims.mjs [--root <dir>]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parses top-level `jobs:` keys and every `run:` command from a GitHub Actions workflow.
 */
export function parseWorkflow(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const jobs = new Set();
  const runCommands = [];

  let inJobs = false;
  let jobsIndent = -1;
  let inBlockRun = false;
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.search(/\S/);

    if (inBlockRun) {
      if (indent > blockIndent) {
        runCommands.push(trimmed);
        continue;
      }
      inBlockRun = false;
    }

    if (/^jobs:\s*$/.test(trimmed) && indent === 0) {
      inJobs = true;
      jobsIndent = -1;
      continue;
    }

    if (inJobs && indent === 0 && /^[a-zA-Z0-9_-]+:/.test(trimmed)) {
      inJobs = false;
    }

    if (inJobs) {
      if (jobsIndent === -1 && indent > 0) {
        jobsIndent = indent;
      }
      if (indent === jobsIndent) {
        const m = /^([a-zA-Z0-9_-]+):\s*(?:#.*)?$/.exec(trimmed);
        if (m) jobs.add(m[1]);
      }
    }

    const runInline = /^(?:-\s+)?run:\s*(.+)$/.exec(trimmed);
    if (runInline) {
      const val = runInline[1].trim();
      if (val === "|" || val === "|-" || val === ">") {
        inBlockRun = true;
        blockIndent = indent;
      } else {
        runCommands.push(val);
      }
    }
  }

  return { jobs, runCommands };
}

/**
 * Normalizes a command string to a canonical token like `npm run test` or `node scripts/foo.mjs`
 * or `npx tsc -p e2e/x402`.
 */
function normalizeCmd(line) {
  const stripped = line
    .replace(/#.*$/, "")
    .replace(/^sudo\s+.*?"(npm run [^"]+)"'?.*$/, "$1")
    .trim();
  if (!stripped) return [];

  // Split chained `&&` commands
  const parts = stripped.split(/\s*&&\s*/);
  const tokens = [];
  for (const p of parts) {
    const s = p.trim();
    const npmRun = /\bnpm\s+run\s+([\w:-]+)/.exec(s);
    if (npmRun) {
      tokens.push(`npm run ${npmRun[1]}`);
      continue;
    }
    if (/\bnpm\s+test\b/.test(s)) {
      tokens.push("npm test");
      continue;
    }
    const nodeScript = /\bnode\s+(scripts\/[\w./-]+\.mjs)/.exec(s);
    if (nodeScript) {
      tokens.push(`node ${nodeScript[1]}`);
      continue;
    }
    const npxTsc = /\bnpx\s+tsc\s+-p\s+([\w./-]+)/.exec(s);
    if (npxTsc) {
      tokens.push(`npx tsc -p ${npxTsc[1]}`);
      continue;
    }
  }
  return tokens;
}

/**
 * Extracts claimed job names and the "Checks (CI runs exactly these)" commands from docs.
 */
export function checkCiClaims(rootDir = DEFAULT_ROOT) {
  const errors = [];
  const ciPath = join(rootDir, ".github", "workflows", "ci.yml");
  const contribPath = join(rootDir, "CONTRIBUTING.md");
  const archPath = join(rootDir, "docs", "architecture.md");

  const ciText = readFileSync(ciPath, "utf8");
  const { jobs, runCommands } = parseWorkflow(ciText);

  const ciTokens = new Set();
  for (const cmd of runCommands) {
    for (const tok of normalizeCmd(cmd)) {
      ciTokens.add(tok);
    }
  }

  // 1. Check job name claims in CONTRIBUTING.md and docs/architecture.md
  const jobClaimRegex = /CI runs (?:it )?as the `([\w-]+)` job/;
  for (const docPath of [contribPath, archPath]) {
    let text;
    try {
      text = readFileSync(docPath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const m = jobClaimRegex.exec(line);
      if (m && !jobs.has(m[1])) {
        errors.push(`${docPath}:${idx + 1}: claims CI job \`${m[1]}\`, which is not in .github/workflows/ci.yml`);
      }
    });
  }

  // 2. Check "Checks (CI runs exactly these)" fenced block in CONTRIBUTING.md
  const contribText = readFileSync(contribPath, "utf8");
  const contribLines = contribText.split(/\r?\n/);

  const ignoreSet = new Set();
  for (const line of contribLines) {
    const ign = /<!--\s*ci-claims:\s*ignore:\s*([^>]+)-->/.exec(line);
    if (ign) {
      for (const item of ign[1].split(",")) {
        const trimmed = item.trim();
        if (trimmed) ignoreSet.add(trimmed);
      }
    }
  }

  const headerIdx = contribLines.findIndex((l) => /^##\s+Checks\s+\(CI runs exactly these\)/.test(l));
  if (headerIdx === -1) {
    errors.push(`${contribPath}:1: missing "## Checks (CI runs exactly these)" section`);
  } else {
    let inFence = false;
    const docTokens = new Set();
    for (let i = headerIdx + 1; i < contribLines.length; i++) {
      const line = contribLines[i];
      if (/^##\s+/.test(line) && !inFence) break;
      if (/^```/.test(line.trim())) {
        if (!inFence) {
          inFence = true;
          continue;
        } else {
          break;
        }
      }
      if (inFence) {
        for (const tok of normalizeCmd(line)) {
          docTokens.add(tok);
          if (!ciTokens.has(tok) && !ignoreSet.has(tok)) {
            errors.push(`${contribPath}:${i + 1}: lists "${tok}", which is not run in .github/workflows/ci.yml`);
          }
        }
      }
    }

    for (const tok of ciTokens) {
      if (!docTokens.has(tok) && !ignoreSet.has(tok)) {
        errors.push(`${ciPath}: runs "${tok}", which is omitted from "Checks (CI runs exactly these)" in CONTRIBUTING.md`);
      }
    }
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rootIdx = process.argv.indexOf("--root");
  const rootDir = rootIdx !== -1 && process.argv[rootIdx + 1] ? resolve(process.argv[rootIdx + 1]) : DEFAULT_ROOT;
  const errors = checkCiClaims(rootDir);
  if (errors.length > 0) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  console.log("ci-claims: OK");
}
