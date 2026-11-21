#!/usr/bin/env node
/**
 * Codemod: rewrites physical Tailwind utilities in class strings to logical
 * equivalents (ml- -> ms-, mr- -> me-, pl- -> ps-, pr- -> pe-, left- -> start-,
 * right- -> end-, text-left -> text-start, text-right -> text-end,
 * rounded-l -> rounded-s, border-l -> border-s, etc.).
 *
 * Symmetric centering patterns (`left-1/2` paired with `-translate-x-1/2` in
 * the same class list) are left untouched.
 *
 * Usage:
 *   node scripts/codemods/logical-tailwind.mjs [--check]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN_RULES = [
  // Spacing & positioning (supports optional negative `-` and variant prefixes like `hover:`, `sm:`)
  [/^((?:[a-z0-9-]+:)*)(-?)ml-/, "$1$2ms-"],
  [/^((?:[a-z0-9-]+:)*)(-?)mr-/, "$1$2me-"],
  [/^((?:[a-z0-9-]+:)*)(-?)pl-/, "$1$2ps-"],
  [/^((?:[a-z0-9-]+:)*)(-?)pr-/, "$1$2pe-"],
  [/^((?:[a-z0-9-]+:)*)(-?)left-/, "$1$2start-"],
  [/^((?:[a-z0-9-]+:)*)(-?)right-/, "$1$2end-"],
  // Text alignment
  [/^((?:[a-z0-9-]+:)*)text-left$/, "$1text-start"],
  [/^((?:[a-z0-9-]+:)*)text-right$/, "$1text-end"],
  // Border radius
  [/^((?:[a-z0-9-]+:)*)rounded-tl(?=$|-)/, "$1rounded-ss"],
  [/^((?:[a-z0-9-]+:)*)rounded-tr(?=$|-)/, "$1rounded-se"],
  [/^((?:[a-z0-9-]+:)*)rounded-bl(?=$|-)/, "$1rounded-es"],
  [/^((?:[a-z0-9-]+:)*)rounded-br(?=$|-)/, "$1rounded-ee"],
  [/^((?:[a-z0-9-]+:)*)rounded-l(?=$|-)/, "$1rounded-s"],
  [/^((?:[a-z0-9-]+:)*)rounded-r(?=$|-)/, "$1rounded-e"],
  // Borders
  [/^((?:[a-z0-9-]+:)*)border-l(?=$|-)/, "$1border-s"],
  [/^((?:[a-z0-9-]+:)*)border-r(?=$|-)/, "$1border-e"],
];

/**
 * Transforms a single Tailwind class list string to logical utilities.
 * Leaves `left-1/2` untouched when `-translate-x-1/2` is present in the same list.
 */
export function transformClassString(cls) {
  const tokens = cls.split(/(\s+)/);
  const hasCenterTranslate = tokens.some((t) => /(?:^|:)-translate-x-1\/2$/.test(t));
  const hasCenterLeft = tokens.some((t) => /(?:^|:)left-1\/2$/.test(t));
  const preserveCenter = hasCenterTranslate && hasCenterLeft;

  return tokens
    .map((tok) => {
      if (!tok || /^\s+$/.test(tok)) return tok;
      if (preserveCenter && /(?:^|:)left-1\/2$/.test(tok)) return tok;
      for (const [re, rep] of TOKEN_RULES) {
        if (re.test(tok)) {
          return tok.replace(re, rep);
        }
      }
      return tok;
    })
    .join("");
}

/**
 * Rewrites string literals in JSX className attributes and cn(...) / clsx(...) calls.
 * Skips dynamic template expressions (${...}) and reports how many were skipped.
 */
export function transformSource(source) {
  let skippedTemplates = 0;
  let changed = false;

  // 1. className="..." or className='...'
  let out = source.replace(
    /(\bclassName\s*=\s*)(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\2/g,
    (full, prefix, quote, body) => {
      const next = transformClassString(body);
      if (next !== body) changed = true;
      return `${prefix}${quote}${next}${quote}`;
    },
  );

  // 2. className={`...`} or className={cn("...", '...')}
  out = out.replace(
    /(\bclassName\s*=\s*\{)([^}]*)(\})/g,
    (full, open, inner, close) => {
      if (inner.includes("${")) {
        // Transform static string literals inside the expression, skip template interpolation parts
        skippedTemplates++;
      }
      const nextInner = inner.replace(
        /(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1/g,
        (m, q, body) => {
          const next = transformClassString(body);
          if (next !== body) changed = true;
          return `${q}${next}${q}`;
        },
      );
      return `${open}${nextInner}${close}`;
    },
  );

  // 3. Static string literals inside cn(...) / clsx(...) even outside JSX attributes
  out = out.replace(
    /(\b(?:cn|clsx)\s*\()([^)]*)(\))/g,
    (full, open, inner, close) => {
      const nextInner = inner.replace(
        /(["'])([^"'\\]*(?:\\.[^"'\\]*)*)\1/g,
        (m, q, body) => {
          const next = transformClassString(body);
          if (next !== body) changed = true;
          return `${q}${next}${q}`;
        },
      );
      return `${open}${nextInner}${close}`;
    },
  );

  return { code: out, changed, skippedTemplates };
}

function walkTsx(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walkTsx(full, acc);
    } else if (entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const checkOnly = process.argv.includes("--check");
  const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
  const files = [...walkTsx(join(root, "app")), ...walkTsx(join(root, "components"))];
  let modifiedCount = 0;
  let totalSkipped = 0;
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const { code, changed, skippedTemplates } = transformSource(raw);
    totalSkipped += skippedTemplates;
    if (changed) {
      modifiedCount++;
      if (checkOnly) {
        console.log(`would update: ${relative(root, file)}`);
      } else {
        writeFileSync(file, code, "utf8");
        console.log(`updated: ${relative(root, file)}`);
      }
    }
  }
  console.log(`Done. ${modifiedCount} file(s) ${checkOnly ? "would be " : ""}modified. Template expressions noted: ${totalSkipped}.`);
}
