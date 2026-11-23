// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LifecycleTimelineView } from "../lifecycle-timeline";
import type { LifecycleEntry } from "@/lib/stellar/market-lifecycle";

describe("LifecycleTimelineView", () => {
  const entries: LifecycleEntry[] = [
    {
      kind: "created",
      ledger: null,
      closedAt: null,
      txHash: null,
      source: "state",
      contractId: "CMARKET",
      detail: { creator: "GABC", closeTime: "1760790000", stateDerived: "true" },
      eventIds: ["state:created"],
    },
    {
      kind: "retention-gap",
      ledger: 900,
      closedAt: null,
      txHash: null,
      source: "state",
      contractId: null,
      detail: { oldestLedger: "900", partial: "true" },
      eventIds: ["gap:900"],
    },
    {
      kind: "resolved",
      ledger: 1100,
      closedAt: "2026-10-18T13:00:00Z",
      txHash: "a".repeat(64),
      source: "market-core",
      contractId: "CMARKET",
      detail: { outcome: "Yes" },
      eventIds: ["ev-1"],
    },
  ];

  it("renders ordered list semantics, gap separator, and invokes Load older", () => {
    const onLoadOlder = vi.fn();
    render(<LifecycleTimelineView entries={entries} partial onLoadOlder={onLoadOlder} />);

    const list = screen.getByRole("list", { name: /Market lifecycle timeline/i });
    expect(list.tagName).toBe("OL");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/History before ledger 900 is outside RPC retention/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Load older/i }));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
