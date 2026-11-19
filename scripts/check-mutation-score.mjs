import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const THRESHOLDS = {
  "lib/stellar/units.ts": 90,
  "lib/stellar/trace.ts": 90,
  "lib/stellar/errors.ts": 80,
};

/**
 * Checks all source files for Stryker disable comments without reasons.
 */
function checkDisableComments() {
  const disableRegex = /\/\/\s*Stryker\s+disable/i;
  const validDisableRegex = /\/\/\s*Stryker\s+disable(?:\s+next-line)?\s+[\w-]+\s*:\s*.+/i;

  const errors = [];
  for (const file of Object.keys(THRESHOLDS)) {
    const fullPath = resolve(process.cwd(), file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (disableRegex.test(line)) {
        if (!validDisableRegex.test(line)) {
          errors.push(`${file}:${i + 1}: Stryker disable comment is missing a reason. Expected '// Stryker disable next-line <Mutator>: <reason>'`);
        }
      }
    }
  }

  if (errors.length > 0) {
    console.error("Stryker disable comment validation failed:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    return false;
  }
  return true;
}

export function evaluateMutationReport(jsonPath) {
  if (!existsSync(jsonPath)) {
    console.error(`Mutation report not found at ${jsonPath}`);
    return { success: false, reason: "NOT_FOUND" };
  }

  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const files = data.files || {};

  const results = [];
  const survivors = [];
  let allPassed = true;

  for (const [targetFile, threshold] of Object.entries(THRESHOLDS)) {
    // Match either exact key or relative path
    const matchingKey = Object.keys(files).find((k) => k.endsWith(targetFile) || targetFile.endsWith(k));
    const fileData = matchingKey ? files[matchingKey] : null;

    if (!fileData) {
      results.push({ file: targetFile, killed: 0, survived: 0, total: 0, score: 0, threshold, passed: false });
      allPassed = false;
      continue;
    }

    const mutants = fileData.mutants || [];
    let killed = 0;
    let timeout = 0;
    let survived = 0;
    let noCoverage = 0;

    for (const m of mutants) {
      if (m.status === "Killed") killed++;
      else if (m.status === "Timeout") timeout++;
      else if (m.status === "Survived") {
        survived++;
        survivors.push({
          file: targetFile,
          id: m.id,
          mutator: m.mutatorName,
          line: m.location?.start?.line ?? "unknown",
          replacement: m.replacement,
        });
      } else if (m.status === "NoCoverage") {
        noCoverage++;
        survivors.push({
          file: targetFile,
          id: m.id,
          mutator: m.mutatorName,
          line: m.location?.start?.line ?? "unknown",
          replacement: m.replacement,
        });
      }
    }

    const detected = killed + timeout;
    const total = detected + survived + noCoverage;
    const score = total === 0 ? 100 : (detected / total) * 100;
    const passed = score >= threshold;

    if (!passed) allPassed = false;
    results.push({ file: targetFile, killed: detected, survived: survived + noCoverage, total, score, threshold, passed });
  }

  return { results, survivors, allPassed };
}

function run() {
  const customJsonPath = process.argv[2];
  const reportPath = customJsonPath ? resolve(process.cwd(), customJsonPath) : resolve(process.cwd(), "reports/mutation/mutation.json");

  console.log("Checking Stryker disable comments...");
  if (!checkDisableComments()) {
    process.exit(1);
  }

  console.log(`Evaluating mutation results from: ${reportPath}`);
  const outcome = evaluateMutationReport(reportPath);

  if (!outcome.allPassed && outcome.reason === "NOT_FOUND") {
    process.exit(1);
  }

  console.log("\n=================== MUTATION TESTING SCORE SUMMARY ===================");
  console.log(
    "File".padEnd(25) +
    "Score".padStart(10) +
    "Threshold".padStart(12) +
    "Killed/Total".padStart(15) +
    "Status".padStart(10)
  );
  console.log("-".repeat(72));

  for (const r of outcome.results) {
    const scoreStr = `${r.score.toFixed(2)}%`;
    const threshStr = `${r.threshold}%`;
    const countStr = `${r.killed}/${r.total}`;
    const statusStr = r.passed ? "PASS" : "FAIL";
    console.log(
      r.file.padEnd(25) +
      scoreStr.padStart(10) +
      threshStr.padStart(12) +
      countStr.padStart(15) +
      statusStr.padStart(10)
    );
  }
  console.log("======================================================================\n");

  if (outcome.survivors && outcome.survivors.length > 0) {
    console.log("--- Surviving Mutants ---");
    for (const s of outcome.survivors) {
      console.log(`- [${s.file}:${s.line}] ${s.mutator}: id=${s.id}`);
    }
    console.log("");
  }

  if (!outcome.allPassed) {
    console.error("Mutation score threshold check failed.");
    process.exit(1);
  }

  console.log("All mutation score thresholds satisfied.");
}

if (process.argv[1] && process.argv[1].endsWith("check-mutation-score.mjs")) {
  run();
}
