// Run with: node --test scripts/__tests__/
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest } from "../build-sw-manifest.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "next");

test("reads build id, static routes and every chunk", () => {
  const m = buildManifest(fixture);
  assert.equal(m.buildId, "abc123");
  assert.deepEqual(m.routes, ["/", "/markets", "/offline"]);
  assert.deepEqual(m.assets, [
    "/_next/static/chunks/app/wallet-kit-2.js",
    "/_next/static/chunks/main-1.js",
    "/_next/static/css/a.css",
  ]);
});

test("records SHA-256 digest and byte size for every precached file", () => {
  const m = buildManifest(fixture);
  assert.ok(m.files, "manifest.files must be defined");
  for (const asset of m.assets) {
    const entry = m.files[asset];
    assert.ok(entry, `Entry missing for asset: ${asset}`);
    assert.equal(typeof entry.digest, "string", `Digest missing for: ${asset}`);
    assert.equal(entry.digest.length, 64, `Digest must be 64-character hex for: ${asset}`);
    assert.equal(typeof entry.size, "number", `Size missing for: ${asset}`);
    assert.ok(entry.size > 0, `Size must be positive for: ${asset}`);
  }
});

test("fails if NEXT_PUBLIC_BUILD_ID disagrees with .next/BUILD_ID", () => {
  const original = process.env.NEXT_PUBLIC_BUILD_ID;
  try {
    process.env.NEXT_PUBLIC_BUILD_ID = "different-build-id";
    assert.throws(
      () => buildManifest(fixture),
      /Build ID disagreement/
    );
  } finally {
    process.env.NEXT_PUBLIC_BUILD_ID = original;
  }
});
