import { describe, expect, it } from "vitest";
import { applySocketEvent, explain, parseControlsOverview, pauseOutcome, validatePause } from "../agent-controls";

const NOW = new Date("2026-11-19T12:00:00Z");
const row = (o: Record<string, unknown>) => ({ paused: false, reason: null, source: null, pausedUntil: null, pausedBy: null, version: 1, ...o });
const overview = (all: Record<string, unknown>, trader: Record<string, unknown> = {}) =>
  parseControlsOverview({
    scopes: [
      { scope: "ALL", paused: !!all.paused, own: row(all) },
      { scope: "MARKET_MAKER", paused: !!all.paused, own: row({}) },
      { scope: "TRADER", paused: !!all.paused || !!trader.paused, own: row(trader) },
    ],
    events: [{ id: "1", scope: "ALL", action: "pause", source: "drawdown", createdAt: "2026-11-19T11:00:00Z" }],
  })!;

describe("agent controls", () => {
  it("explains a pause inherited from ALL and ignores expired rows", () => {
    const views = explain(overview({ paused: true, source: "drawdown" }, { paused: true, pausedUntil: "2026-11-19T11:00:00Z" }), NOW);
    expect(views.find((v) => v.scope === "TRADER")).toMatchObject({ effectivePaused: true, inheritedFrom: "ALL" });
    expect(views.find((v) => v.scope === "ALL")).toMatchObject({ effectivePaused: true, inheritedFrom: null });
  });

  it("detects the silent no-op when a longer pause exists", () => {
    const before = overview({ paused: true, pausedUntil: "2026-11-20T00:00:00Z", version: 3 });
    expect(pauseOutcome(before, before, "ALL")).toBe("no-op-longer-exists");
    const after = overview({ paused: true, pausedUntil: "2026-11-21T00:00:00Z", version: 4 });
    expect(pauseOutcome(before, after, "ALL")).toBe("applied");
  });

  it("applies socket events and validates pause input", () => {
    const next = applySocketEvent(overview({}), { scope: "TRADER", paused: true, reason: "manual", until: null });
    expect(next.scopes.find((s) => s.scope === "TRADER")?.own?.paused).toBe(true);
    expect(validatePause({ reason: "abc" }, NOW)).not.toBeNull();
    expect(validatePause({ reason: "valid reason", until: new Date("2026-11-19T11:00:00Z") }, NOW)).not.toBeNull();
    expect(validatePause({ reason: "valid reason" }, NOW)).toBeNull();
  });
});
