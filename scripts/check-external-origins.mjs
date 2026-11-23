#!/usr/bin/env node
/**
 * Fails when the production build references an origin outside the configured
 * API, RPC, IPFS, x402 and explorer set (issue #121).
 *
 * Run after `npm run build`: npm run check:origins
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configuredOrigins,
  findFindings,
  parseAllowlist,
} from "./lib/external-origins.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, ".next");
const SCAN_ROOTS = [
  join(BUILD, "static"),
  join(BUILD, "server", "app"),
];
const EXTENSIONS = new Set([".js", ".css", ".html", ".rsc"]);
const strict = process.argv.includes("--strict");

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else if (EXTENSIONS.has(name.slice(name.lastIndexOf("."))) && !name.endsWith(".map")) files.push(path);
  }
  return files;
}

function main() {
  if (!existsSync(BUILD)) {
    console.error("No .next directory. Run `npm run build` first.");
    process.exit(1);
  }

  const allowPath = join(ROOT, "scripts", "external-origins.allow.json");
  const allowlist = parseAllowlist(JSON.parse(readFileSync(allowPath, "utf8")));
  const allowedOrigins = configuredOrigins(process.env);
  for (const origin of Object.keys(allowlist)) allowedOrigins.add(origin);

  const files = SCAN_ROOTS.flatMap((dir) => walk(dir));
  if (!files.length) {
    console.error("No build files found to scan.");
    process.exit(1);
  }

  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const fetchLikeErrors = /\.(?:html|css)$/.test(file);
    for (const finding of findFindings(text, { allowedOrigins, allowlist, strict, fetchLikeErrors })) {
      const location = `${relative(ROOT, file)}:${finding.line}`;
      const line = `${finding.kind.toUpperCase().padEnd(7)} ${location}  ${finding.origin}  ${finding.context}`;
      if (finding.kind === "error") {
        errors += 1;
        console.error(line);
      } else {
        warnings += 1;
        console.warn(line);
      }
    }
  }

  console.log(
    `Scanned ${files.length} build files: ${errors} error(s), ${warnings} warning(s). Allowed origins: ${[...allowedOrigins].join(", ")}`,
  );
  process.exit(errors ? 1 : 0);
}

main();
