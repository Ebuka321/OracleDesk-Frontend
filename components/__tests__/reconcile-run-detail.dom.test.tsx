import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useReconcileRun, useRecheck } from "@/lib/hooks/useReconciliation";
import { ReconcileRunDetail } from "../admin/reconcile-run-detail";
import type { ReconcileRun } from "@/lib/api/admin";
import type { DriftFinding } from "@/lib/admin/drift";
import type { RecheckResult } from "@/lib/admin/recheck";

vi.mock("@/lib/hooks/useReconciliation", () => ({
  useReconcileRun: vi.fn(),
  useRecheck: vi.fn(),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({ refetchQueries: vi.fn() }) };
});

vi.mock("@/components/ui/virtual-list", () => ({
  VirtualTableBody: ({
    items,
    renderRow,
  }: {
    items: readonly DriftFinding[];
    renderRow: (item: DriftFinding, index: number, a11y: { "aria-rowindex": number }) => React.ReactNode;
  }) => (
    <tbody>
      {items.map((item, index) => (
        <React.Fragment key={item.id ?? String(index)}>
          {renderRow(item, index, { "aria-rowindex": index + 1 })}
        </React.Fragment>
      ))}
    </tbody>
  ),
}));

const run: ReconcileRun = {
  id: "run-1",
  startedAt: "2026-10-18T12:00:00.000Z",
  finishedAt: "2026-10-18T12:01:00.000Z",
  scanned: 10,
  repaired: 1,
  reported: 2,
  deferred: 0,
  rpcCalls: 12,
  error: null,
};

const findings: DriftFinding[] = [
  {
    id: "f1",
    runId: "run-1",
    marketId: "m1",
    onChainMarketId: "42",
    driftClass: "HASH_MISMATCH",
    action: "REPORTED",
    dbValue: { questionHash: "aa".repeat(32) },
    chainValue: { questionHash: "bb".repeat(32) },
    observedLedger: 500,
  },
  {
    id: "f2",
    runId: "run-1",
    marketId: "m2",
    onChainMarketId: "43",
    driftClass: "PRICE_STALE",
    action: "REPAIRED",
    dbValue: { currentYesProb: 0.6 },
    chainValue: { currentYesProb: 0.5 },
    observedLedger: 500,
  },
];

function setQueries(runOver: Partial<typeof run> = {}, recheckData?: Map<string, RecheckResult>) {
  vi.mocked(useReconcileRun).mockReturnValue({
    data: {
      pages: [{
        run: { ...run, ...runOver },
        findings,
        meta: { page: 1, limit: 200, total: findings.length, totalPages: 1 },
      }],
    },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useReconcileRun>);

  vi.mocked(useRecheck).mockReturnValue({
    data: recheckData ?? new Map([["f1", { status: "still-holds", ledger: 500, checkedAt: 0 }]]) as Map<string, RecheckResult>,
    refetch: vi.fn(),
    isFetching: false,
  } as unknown as ReturnType<typeof useRecheck>);
}

describe("ReconcileRunDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setQueries();
  });

  it("renders summary, findings, hashes, links and re-check state", () => {
    render(<ReconcileRunDetail runId="run-1" />);
    const table = within(screen.getByRole("table"));
    expect(screen.getByText("run-1")).toBeDefined();
    expect(table.getByText("HASH_MISMATCH")).toBeDefined();
    expect(table.getByText("REPORTED")).toBeDefined();
    expect(screen.getByText("Still holds")).toBeDefined();
    expect(screen.getByRole("link", { name: "42" }).getAttribute("href")).toBe("/markets/quick-view?onChainId=42");
    expect(screen.getByText(/aa.*aa/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Load all (up to 5,000)" })).toBeDefined();
  });

  it("filters integrity classes and hides price re-checks until asked", () => {
    render(<ReconcileRunDetail runId="run-1" />);
    expect(within(screen.getByRole("table")).getByText("PRICE_STALE")).toBeDefined();
    expect(screen.getAllByText("Hidden").length).toBe(1);

    fireEvent.click(screen.getByLabelText("Show price re-checks"));
    expect(within(screen.getByRole("table")).getByText("Not checked")).toBeDefined();

    fireEvent.click(screen.getByLabelText("Integrity only"));
    expect(within(screen.getByRole("table")).queryByText("PRICE_STALE")).toBeNull();
  });

  it("labels a skipped lock-held run without calling it a failure", () => {
    setQueries({ error: "another instance is reconciling; run skipped" });
    render(<ReconcileRunDetail runId="run-1" />);
    expect(screen.getByText(/Skipped \(lock held\)/)).toBeDefined();
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it("keeps unknown classes visible and flagged", () => {
    const unknown: DriftFinding = {
      ...findings[0],
      id: "f3",
      driftClass: "FUTURE_CLASS",
      action: "FUTURE_ACTION",
    };
    vi.mocked(useReconcileRun).mockReturnValue({
      data: { pages: [{ run, findings: [unknown], meta: { page: 1, limit: 200, total: 1, totalPages: 1 } }] },
      isLoading: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useReconcileRun>);
    render(<ReconcileRunDetail runId="run-1" />);
    const table = within(screen.getByRole("table"));
    expect(table.getByText("unknown class")).toBeDefined();
    expect(table.getByText("unknown action")).toBeDefined();
  });
});
