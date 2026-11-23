import { describe, expect, it } from "vitest";
import { validateAllowlist } from "../run-allowed-install-scripts.mjs";

describe("install-script allowlist", () => {
  it("accepts an allowlisted package with a reason", () => {
    const packageJson = { allowedInstallScripts: [{ name: "sharp", reason: "image optimization" }] };
    const lock = { packages: { "node_modules/sharp": { hasInstallScript: true } } };
    expect(validateAllowlist(packageJson, lock)).toEqual([]);
  });

  it("fails when an allowlisted package is missing from the lockfile", () => {
    const packageJson = { allowedInstallScripts: [{ name: "sharp", reason: "image optimization" }] };
    expect(validateAllowlist(packageJson, { packages: {} })).toEqual([
      "sharp is allowlisted but is not in package-lock.json",
    ]);
  });

  it("fails when an entry has no reason", () => {
    const packageJson = { allowedInstallScripts: [{ name: "sharp" }] };
    const lock = { packages: { "node_modules/sharp": { hasInstallScript: true } } };
    expect(validateAllowlist(packageJson, lock)).toContain("sharp needs a reason");
  });
});
