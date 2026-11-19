import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export function extractCodesFromDoc(docPath) {
  const content = fs.readFileSync(docPath, "utf8");
  const regex = /\b([1-5][0-9]{2})\s+([A-Z][A-Z0-9_]+)\b/g;
  const codes = new Set();
  let m;
  while ((m = regex.exec(content)) !== null) {
    codes.add(m[2]);
  }
  return Array.from(codes).sort();
}

export function extractCodesFromSource(sourcePath) {
  const content = fs.readFileSync(sourcePath, "utf8");
  const match = content.match(/export const API_ERROR_CODES = \[(.*?)\] as const;/s);
  if (!match) {
    throw new Error(`Could not find API_ERROR_CODES in ${sourcePath}`);
  }
  const codes = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return codes;
}

const SYNTHESIZED_CODES = new Set(["TRACE_LOCKED", "BACKEND_UNREACHABLE", "HTTP_UNKNOWN"]);

export function checkApiErrorCodes(docPath, sourcePath) {
  const docCodes = extractCodesFromDoc(docPath);
  const sourceCodes = extractCodesFromSource(sourcePath);

  const docSet = new Set(docCodes);
  const sourceSet = new Set(sourceCodes);

  const missingInSource = docCodes.filter((c) => !sourceSet.has(c));
  const missingInDoc = sourceCodes.filter((c) => !docSet.has(c) && !SYNTHESIZED_CODES.has(c));

  return {
    docCodes,
    sourceCodes,
    missingInSource,
    missingInDoc,
    ok: missingInSource.length === 0 && missingInDoc.length === 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const isCheck = process.argv.includes("--check");
  const docPath = path.join(rootDir, "docs/api.md");
  const sourcePath = path.join(rootDir, "lib/errors/codes.ts");
  const generatedPath = path.join(rootDir, "lib/errors/api-codes.generated.json");

  const result = checkApiErrorCodes(docPath, sourcePath);

  // Write generated JSON
  fs.writeFileSync(
    generatedPath,
    JSON.stringify(
      {
        extractedFromDoc: result.docCodes,
        synthesized: Array.from(SYNTHESIZED_CODES),
        allSupported: result.sourceCodes,
      },
      null,
      2,
    ) + "\n",
  );

  if (isCheck && !result.ok) {
    if (result.missingInSource.length > 0) {
      console.error(
        `Error: docs/api.md contains codes not listed in API_ERROR_CODES: ${result.missingInSource.join(", ")}`,
      );
    }
    if (result.missingInDoc.length > 0) {
      console.error(
        `Error: API_ERROR_CODES contains backend codes not documented in docs/api.md: ${result.missingInDoc.join(", ")}`,
      );
    }
    process.exit(1);
  }

  if (isCheck) {
    console.log("All API error codes are synchronized between docs/api.md and lib/errors/codes.ts.");
  }
}
