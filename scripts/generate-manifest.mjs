#!/usr/bin/env node
/**
 * Generates a deterministic content-addressed manifest of static build output.
 * Walks the output directory (default: 'out'), computes SHA-256 for every file,
 * sorts by path, records sizes, and outputs manifest.json with directory summary.
 *
 * If ipfs or ipfs-car CLI is available, also computes the IPFS directory CID.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = process.argv[2] ? join(rootDir, process.argv[2]) : join(rootDir, "out");

function walk(dir) {
  const files = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else if (entry.isFile()) files.push(full);
    }
  } catch (err) {
    console.error(`Cannot read directory ${dir}: ${err.message}`);
  }
  return files;
}

function getCommitSha() {
  try {
    return execSync("git rev-parse HEAD", { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return process.env.NEXT_PUBLIC_BUILD_ID || "unknown-commit";
  }
}

function getIpfsCid(dirPath) {
  // Check ipfs CLI
  try {
    execSync("which ipfs", { stdio: "ignore" });
    const output = execSync(`ipfs add -r -Q --only-hash --cid-version=1 "${dirPath}"`, {
      encoding: "utf8",
    }).trim();
    return output;
  } catch {
    // Check ipfs-car CLI
    try {
      execSync("which ipfs-car", { stdio: "ignore" });
      const output = execSync(`ipfs-car --hash "${dirPath}"`, { encoding: "utf8" }).trim();
      return output;
    } catch {
      return null;
    }
  }
}

console.log(`Generating static build manifest for: ${outDir}`);
const allFiles = walk(outDir);

if (allFiles.length === 0) {
  console.warn(`Warning: No files found in ${outDir}. Has 'next build' run with output: 'export'?`);
}

const fileEntries = [];

for (const file of allFiles) {
  const relPath = relative(outDir, file).split(sep).join("/");
  if (relPath === "manifest.json" || relPath === "manifest.sha256") continue;

  const content = readFileSync(file);
  const size = statSync(file).size;
  const hash = createHash("sha256").update(content).digest("hex");

  fileEntries.push({
    path: relPath,
    size,
    sha256: hash,
  });
}

// Deterministic sort by relative path
fileEntries.sort((a, b) => a.path.localeCompare(b.path));

const commit = getCommitSha();
const ipfsCid = getIpfsCid(outDir);

const manifest = {
  version: 1,
  commit,
  generatedAt: new Date().toISOString(),
  ipfsCid: ipfsCid || "PENDING_IPFS_TOOLING (install 'ipfs' or 'ipfs-car' CLI to calculate CID)",
  totalFiles: fileEntries.length,
  totalBytes: fileEntries.reduce((sum, f) => sum + f.size, 0),
  files: fileEntries,
};

const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
const manifestPath = join(outDir, "manifest.json");
writeFileSync(manifestPath, manifestJson);

const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");
writeFileSync(join(outDir, "manifest.sha256"), `${manifestSha256}  manifest.json\n`);

console.log(`Manifest written to ${manifestPath}`);
console.log(`Total files: ${manifest.totalFiles}`);
console.log(`Manifest SHA-256: ${manifestSha256}`);
if (ipfsCid) {
  console.log(`IPFS Directory CIDv1: ${ipfsCid}`);
} else {
  console.log("IPFS Directory CID: Not computed (requires 'ipfs' or 'ipfs-car' CLI in path)");
}
