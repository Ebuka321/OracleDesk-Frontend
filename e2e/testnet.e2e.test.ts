/**
 * End-to-end check against a running backend and live Stellar testnet,
 * using the frontend's own lib/stellar code. Not part of `npm test`.
 *
 *   API_URL=http://localhost:8000/api/v1 \
 *   EXPECTED_YES_BPS=5319 \          # from: stellar contract invoke … -- get_price --market_id 1 --outcome Yes
 *   DEMO_TRACE_FILE=/path/to/bytes \ # optional: exact bytes of a trace published by scripts/demo.sh
 *   DEMO_TRACE_ID=1 \
 *   npm run e2e:testnet
 *
 * Read-only: it simulates contract calls and never signs or submits.
 *
 * Recording fixtures:
 * Run `npm run fixtures:record` when testnet state or contracts change to refresh
 * the deterministic offline replay fixtures in e2e/fixtures/.
 */
import { describe, it } from "vitest";
import { checkDemoTrace, checkJoin, checkPrice } from "./phase-d";

const API_URL = process.env.API_URL ?? "http://localhost:8000/api/v1";
const MARKET_ID = process.env.MARKET_ID ?? "1";

describe("Phase D: backend + testnet", () => {
  it("1. backend markets join to on-chain data", async () => {
    await checkJoin(API_URL);
  });

  it("2. on-chain price matches market_core.get_price from the CLI", async () => {
    await checkPrice(
      MARKET_ID,
      process.env.EXPECTED_YES_BPS ? Number(process.env.EXPECTED_YES_BPS) : undefined
    );
  });

  it.runIf(Boolean(process.env.DEMO_TRACE_FILE))(
    "4. a demo.sh trace verifies, a tampered copy does not",
    async () => {
      await checkDemoTrace(process.env.DEMO_TRACE_FILE, process.env.DEMO_TRACE_ID ?? "1");
    }
  );
});
