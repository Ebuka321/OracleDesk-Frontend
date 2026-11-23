#!/usr/bin/env node
/**
 * Scans the production build for leaked secrets and forbidden NEXT_PUBLIC_*
 * names (issue #118). Findings print a file, position, detector and a hash
 * prefix; the secret itself is never echoed.
 *
 * Run after `npm run build`: npm run scan:secrets
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPublicEnvNames, findSecrets } from "./lib/secret-detectors.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, ".next");
const SOURCE_DIRS = ["app", "lib", "components"];
const SAMPLE = /\.(?:js|css|html|rsc)$/;
const strFlag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const strict = process.argv.includes("--strict");
const allowedNames = new Set(
  (strFlag("--allow-name") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

const hash = (value) => createHash("sha256").update(value).digest("hex");

/** Public names compiled in by wallet libraries; none are application secrets. */
const DEPENDENCY_PUBLIC_NAMES = new Set([
  "NEXT_PUBLIC_DEFAULT_LOG_LEVEL",
  "NEXT_PUBLIC_SECURE_SITE_ORIGIN",
  "NEXT_PUBLIC_SECURE_SITE_SDK_URL",
  "NEXT_PUBLIC_SECURE_SITE_SDK_VERSION",
]);

export function allowedEnvNames(envExample, extra = []) {
  const names = new Set(extra);
  for (const line of envExample.split(/\r?\n/)) {
    const match = /^(NEXT_PUBLIC_[A-Z0-9_]+)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return names;
}

export function allowedValueHashes(deployments, allowEntries = []) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.trim()) values.add(hash(value.trim()));
  };
  add(deployments?.deployer);
  add(deployments?.agent);
  for (const value of Object.values(deployments?.contracts ?? {})) add(value);
  for (const entry of allowEntries) {
    if (entry && typeof entry.value_sha256 === "string") values.add(entry.value_sha256.replace(/^sha256:/, ""));
  }
  return values;
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (name === "cache") continue;
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else if (SAMPLE.test(name) && !name.endsWith(".map")) files.push(path);
  }
  return files;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function main() {
  if (!existsSync(BUILD)) {
    console.error("No .next directory. Run `npm run build` first.");
    process.exit(1);
  }

  const envExample = readFileSync(join(ROOT, ".env.example"), "utf8");
  const names = allowedEnvNames(envExample, [...allowedNames, ...DEPENDENCY_PUBLIC_NAMES]);
  const deployments = JSON.parse(
    readFileSync(join(ROOT, "lib", "stellar", "generated", "deployments.testnet.json"), "utf8"),
  );
  const allowPath = join(ROOT, "scripts", "scan-build-secrets.allow.json");
  const allowEntries = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, "utf8")) : [];
  const allowedValues = allowedValueHashes(deployments, allowEntries);

  let errors = 0;
  let warnings = 0;
  const report = (kind, file, line, detector, value, extra = "") => {
    const prefix = value ? ` sha256:${hash(value).slice(0, 12)}…` : "";
    const text = `${kind.toUpperCase().padEnd(7)} ${relative(ROOT, file)}:${line} ${detector}${prefix}${extra}`;
    if (kind === "error") {
      errors += 1;
      console.error(text);
    } else {
      warnings += 1;
      console.warn(text);
    }
  };

  // Source references: a forbidden name fails even when the value is unset.
  const sourceFiles = SOURCE_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
    .filter((file) => !file.includes(`${join("stellar", "generated")}`));
  for (const file of sourceFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)) {
      if (!names.has(match[1])) {
        report("error", file, lineOf(text, match.index ?? 0), "unlisted NEXT_PUBLIC name", match[1]);
      }
    }
  }

  // Build output: static chunks and prerendered HTML/RSC are browser-visible.
  const browserFiles = [...walk(join(BUILD, "static")), ...walk(join(BUILD, "server", "app"))];
  for (const file of browserFiles) {
    const text = readFileSync(file, "utf8");
    for (const name of findPublicEnvNames(text)) {
      if (!names.has(name)) report("error", file, 1, "unlisted NEXT_PUBLIC name", name);
    }

    for (const finding of findSecrets(text, { allowed: allowedValues, createHash: hash })) {
      const value = finding.token ?? text.slice(finding.index, finding.index + finding.length);
      let kind = "error";
      if (finding.kind === "high-entropy") {
        const before = text.slice(Math.max(0, finding.index - 120), finding.index);
        const inEnvAssignment = /NEXT_PUBLIC_[A-Z0-9_]+\s*[:=]\s*["'`]?[A-Za-z0-9+/_=-]*$/.test(before);
        kind = inEnvAssignment || strict ? "error" : "warning";
      }
      report(kind, file, lineOf(text, finding.index), `detector:${finding.kind}`, value);
    }
  }

  console.log(`Scanned ${browserFiles.length} build files: ${errors} error(s), ${warnings} warning(s).`);
  process.exit(errors ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
