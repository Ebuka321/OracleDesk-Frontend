// Verifies the security headers on the built app. Run after `npm run build`:
//   npm run check:headers
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROUTES = [
  "/",
  "/markets",
  "/markets/quick-view?onChainId=1",
  "/reasoning/verify?onChainTraceId=1",
  "/premium",
  "/copy-trade",
];

const REQUIRED = [
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "x-content-type-options",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Which required headers are missing from a response. */
export function missingHeaders(headers, production = true) {
  const missing = REQUIRED.filter((name) => !headers.get(name));
  if (!headers.get("content-security-policy") && !headers.get("content-security-policy-report-only")) {
    missing.push("content-security-policy");
  }
  if (production && !headers.get("strict-transport-security")) missing.push("strict-transport-security");
  return missing;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`next start did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function main() {
  const port = Number(process.env.PORT || 4311);
  const base = `http://127.0.0.1:${port}`;
  const production = process.env.NODE_ENV !== "development";
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitForServer(base);
    const problems = [];
    for (const route of ROUTES) {
      const response = await fetch(`${base}${route}`, { redirect: "manual" });
      if (response.status >= 400) {
        problems.push(`${route}: HTTP ${response.status}`);
        continue;
      }
      for (const name of missingHeaders(response.headers, production)) {
        problems.push(`${route}: missing ${name}`);
      }
    }
    if (problems.length) {
      console.error(`Security header check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
      for (const problem of problems) console.error(`  ${problem}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Security headers present on ${ROUTES.length} routes.`);
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    if (!child.killed) child.kill("SIGKILL");
    if (process.exitCode) console.error(output.slice(-2000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
