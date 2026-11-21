import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCiClaims } from "../check-ci-claims.mjs";

function setupTempRepo({ ciYml, contributing, arch = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-claims-"));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, ".github", "workflows", "ci.yml"), ciYml);
  writeFileSync(join(dir, "CONTRIBUTING.md"), contributing);
  writeFileSync(join(dir, "docs", "architecture.md"), arch);
  return dir;
}

describe("check-ci-claims", () => {
  it("passes on the repository's real files", () => {
    const errors = checkCiClaims();
    assert.deepEqual(errors, []);
  });

  it("fails when CONTRIBUTING names a job absent from the workflow", () => {
    const dir = setupTempRepo({
      ciYml: `
jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
      contributing: `
## Checks (CI runs exactly these)
\`\`\`bash
npm test
\`\`\`
CI runs it as the \`x402-contract\` job.
`,
    });
    try {
      const errors = checkCiClaims(dir);
      assert.ok(errors.some((e) => e.includes("x402-contract") && e.includes("CONTRIBUTING.md")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when CI runs a command missing from the exactly-these block", () => {
    const dir = setupTempRepo({
      ciYml: `
jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run lint
`,
      contributing: `
## Checks (CI runs exactly these)
\`\`\`bash
npm test
\`\`\`
`,
    });
    try {
      const errors = checkCiClaims(dir);
      assert.ok(errors.some((e) => e.includes("npm run lint")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects the ignore allowlist", () => {
    const dir = setupTempRepo({
      ciYml: `
jobs:
  frontend:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
      - run: npm run perf:lhci
`,
      contributing: `
## Checks (CI runs exactly these)
<!-- ci-claims: ignore: npm run perf:lhci -->
\`\`\`bash
npm test
\`\`\`
`,
    });
    try {
      const errors = checkCiClaims(dir);
      assert.deepEqual(errors, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
