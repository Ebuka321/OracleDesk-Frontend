import { describe, expect, it } from "vitest";
import { nextDataMode, type ModeInput } from "../data-mode";

const input = (over: Partial<ModeInput> & { backend?: "ok" | "down"; rpc?: "ok" | "degraded" | "down" } = {}): ModeInput => ({
  backend: { status: over.backend ?? "ok", checkedAt: 0 },
  rpc: { status: over.rpc ?? "ok", latestLedger: 1, ledgerAgeSec: 0, checkedAt: 0 },
  backendDownStreak: over.backendDownStreak ?? 0,
  backendOkStreak: over.backendOkStreak ?? 0,
  apiFailures: over.apiFailures ?? 0,
});

describe("nextDataMode", () => {
  it("needs two down probes to enter chain-only", () => {
    expect(nextDataMode("full", input({ backend: "down", backendDownStreak: 1 }))).toBe("full");
    expect(nextDataMode("full", input({ backend: "down", backendDownStreak: 2 }))).toBe("chain-only");
  });

  it("enters chain-only after three API failures", () => {
    expect(nextDataMode("full", input({ apiFailures: 2 }))).toBe("full");
    expect(nextDataMode("full", input({ apiFailures: 3 }))).toBe("chain-only");
  });

  it("does not flap on down, ok, down", () => {
    let mode = nextDataMode("full", input({ backend: "down", backendDownStreak: 2 }));
    mode = nextDataMode(mode, input({ backend: "ok", backendOkStreak: 1 }));
    expect(mode).toBe("chain-only");
    mode = nextDataMode(mode, input({ backend: "down", backendDownStreak: 1 }));
    expect(mode).toBe("chain-only");
  });

  it("returns to full after two ok probes", () => {
    expect(nextDataMode("chain-only", input({ backend: "ok", backendOkStreak: 2 }))).toBe("full");
  });

  it("is never chain-only while the RPC is down", () => {
    expect(nextDataMode("full", input({ backend: "down", backendDownStreak: 5, rpc: "down" }))).toBe("full");
    expect(nextDataMode("chain-only", input({ rpc: "down" }))).toBe("full");
  });
});
