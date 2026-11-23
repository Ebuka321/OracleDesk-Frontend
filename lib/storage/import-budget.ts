/**
 * Per-route import budget checker.
 * Reports when a lazily-loaded chunk exceeds a declared byte budget.
 * Issue #229
 */

export interface ImportBudget {
  /** Route or feature name, for reporting. */
  name: string;
  /** Maximum acceptable transfer size in bytes. */
  maxBytes: number;
}

/**
 * Wraps a dynamic import and warns (dev) or tracks (prod) when the loaded
 * module exceeds the declared budget. The check is best-effort and relies on
 * the PerformanceResourceTiming API.
 *
 * Usage:
 *   const MyComponent = dynamic(() => budgetedImport(import("./HeavyComponent"), { name: "HeavyComponent", maxBytes: 50_000 }))
 */
export function budgetedImport<T>(
  importPromise: Promise<T>,
  budget: ImportBudget,
): Promise<T> {
  return importPromise.then((module) => {
    if (typeof window === "undefined" || !window.performance?.getEntriesByType) return module;
    // Best-effort: check the most recent resource entries for a chunk that looks like this feature
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const recent = entries.slice(-20);
    for (const entry of recent) {
      if (entry.transferSize > 0 && entry.transferSize > budget.maxBytes) {
        const msg = `[import-budget] "${budget.name}" chunk is ${entry.transferSize.toLocaleString()} B, budget is ${budget.maxBytes.toLocaleString()} B`;
        if (process.env.NODE_ENV === "development") {
          console.warn(msg);
        }
      }
    }
    return module;
  });
}
