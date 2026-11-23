#!/usr/bin/env node
// Writes the service worker's precache list for the build that just finished.
//
//   next build && node scripts/build-sw-manifest.mjs
//
// public/ has already been copied by then, so the list goes to
// .next/static/sw/precache-<BUILD_ID>.json, served at
// /_next/static/sw/precache-<BUILD_ID>.json (public/sw.js fetches it).
//
// Inputs (Next 16 output layout):
//   .next/BUILD_ID                 build id, also baked in as NEXT_PUBLIC_BUILD_ID
//   .next/prerender-manifest.json  `routes` keys = statically prerendered paths
//   .next/static/**                hashed assets; ALL chunks are listed, including
//                                  the lazily imported wallet-kit chunks.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const PRECACHE_EXT = /\.(js|css|woff2?|ttf|png|svg|jpg|jpeg|webp|ico)$/;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Pure-ish: reads a .next directory, returns the manifest. Exported for tests. */
export function buildManifest(nextDir) {
  const buildId = readFileSync(join(nextDir, "BUILD_ID"), "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(buildId)) throw new Error(`Unexpected BUILD_ID: ${buildId}`);

  // Build-time assertion: if process.env.NEXT_PUBLIC_BUILD_ID is set, it must agree with BUILD_ID
  const envBuildId = process.env.NEXT_PUBLIC_BUILD_ID?.trim();
  if (envBuildId && envBuildId !== buildId) {
    throw new Error(
      `Build ID disagreement: NEXT_PUBLIC_BUILD_ID ("${envBuildId}") does not match .next/BUILD_ID ("${buildId}")`
    );
  }

  const prerender = JSON.parse(readFileSync(join(nextDir, "prerender-manifest.json"), "utf8"));
  const routes = Object.keys(prerender.routes ?? {})
    .filter((r) => r.startsWith("/") && !r.startsWith("/_") && !/\.[a-z0-9]+$/i.test(r) && !r.includes("["))
    .sort();
  if (!routes.includes("/offline")) throw new Error("app/offline must be prerendered for the offline fallback.");
  const staticDir = join(nextDir, "static");
  const assetPaths = walk(staticDir)
    .map((f) => relative(staticDir, f).split(sep).join("/"))
    .filter((p) => !p.startsWith("sw/") && PRECACHE_EXT.test(p))
    .sort();

  const assets = assetPaths.map((p) => `/_next/static/${p}`);

  const files = {};
  for (const p of assetPaths) {
    const fullPath = join(staticDir, p);
    const buf = readFileSync(fullPath);
    const hash = createHash("sha256").update(buf).digest("hex");
    const assetUrl = `/_next/static/${p}`;
    files[assetUrl] = {
      digest: hash,
      size: buf.length,
    };
  }

  // Record route verification strategy: App Router HTML includes per-request
  // dynamic headers and nonces, so routes are verified by 200 status and text/html content-type.
  for (const r of routes) {
    files[r] = {
      verify: "status-and-type",
      type: "text/html",
    };
  }

  return { buildId, routes, assets, files };
}

export function writeManifest(nextDir) {
  const manifest = buildManifest(nextDir);
  const outDir = join(nextDir, "static", "sw");
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `precache-${manifest.buildId}.json`);
  const raw = JSON.stringify(manifest, null, 2);
  const manifestDigest = createHash("sha256").update(raw).digest("hex");
  manifest.manifestDigest = manifestDigest;
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  return { out, manifest };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { out, manifest } = writeManifest(join(root, ".next"));
  console.log(`sw precache: ${manifest.routes.length} routes, ${manifest.assets.length} assets → ${relative(root, out)}`);
}
