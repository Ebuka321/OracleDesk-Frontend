#!/usr/bin/env node
/**
 * Runs the lifecycle scripts explicitly allowed in package.json. Everything
 * else runs with `ignore-scripts=true` from .npmrc (issue #119).
 *
 * Run after `npm ci`: node scripts/run-allowed-install-scripts.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Problems with the allowlist, given package.json and the lockfile. */
export function validateAllowlist(packageJson, lockfile) {
  const problems = [];
  const entries = packageJson.allowedInstallScripts;
  if (!Array.isArray(entries) || entries.length === 0) {
    return ["package.json needs a non-empty allowedInstallScripts list"];
  }
  const lockPackages = lockfile?.packages ?? {};
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || !entry.name.trim()) {
      problems.push("Every allowedInstallScripts entry needs a name");
      continue;
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      problems.push(`${entry.name} needs a reason`);
    }
    const key = `node_modules/${entry.name}`;
    if (!lockPackages[key]) problems.push(`${entry.name} is allowlisted but is not in package-lock.json`);
    else if (!lockPackages[key].hasInstallScript) {
      problems.push(`${entry.name} is allowlisted but has no install script in package-lock.json`);
    }
  }
  return problems;
}

function main() {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const problems = validateAllowlist(packageJson, lockfile);
  if (problems.length) {
    console.error("Install-script allowlist is invalid:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }

  for (const { name, reason } of packageJson.allowedInstallScripts) {
    if (!existsSync(join(ROOT, "node_modules", name))) {
      console.error(`${name} is allowlisted but not installed. Run \`npm ci\` first.`);
      process.exit(1);
    }
    console.log(`Running install script for ${name} (${reason})`);
    const result = spawnSync("npm", ["rebuild", name, "--ignore-scripts=false"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, npm_config_ignore_scripts: "false" },
    });
    if (result.status !== 0) {
      console.error(`Install script for ${name} failed.`);
      process.exit(result.status ?? 1);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
