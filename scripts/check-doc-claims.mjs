// Checks that the docs only reference npm scripts and script files that exist,
// and that the README scripts table lists every package.json script (issue #270).
// Run with: npm run check:docs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "CONTRIBUTING.md", "docs/architecture.md", "docs/STATUS.md", "docs/manual-test.md", "docs/testing.md"];

export function checkDocClaims(root = ROOT, docs = DOCS) {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const failures = [];
  for (const doc of docs) {
    const path = join(root, doc);
    if (!existsSync(path)) continue;
    readFileSync(path, "utf8").split(/\r?\n/).forEach((line, i) => {
      for (const [, name] of line.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
        if (!(name in scripts)) failures.push(`${doc}:${i + 1} npm script "${name}" does not exist`);
      }
      for (const [, file] of line.matchAll(/node (scripts\/[\w./-]+\.mjs)/g)) {
        if (!existsSync(join(root, file))) failures.push(`${doc}:${i + 1} ${file} does not exist`);
      }
    });
  }
  const readme = existsSync(join(root, "README.md")) ? readFileSync(join(root, "README.md"), "utf8") : "";
  for (const name of Object.keys(scripts)) {
    const listed = name === "test" ? readme.includes("`npm test`") : name === "start" ? readme.includes("`npm start`") : readme.includes(`\`npm run ${name}\``);
    if (!listed) failures.push(`README.md: script "${name}" is missing from the scripts table`);
  }
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkDocClaims();
  for (const failure of failures) console.error(failure);
  process.exit(failures.length ? 1 : 0);
}
