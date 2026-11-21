import { findingKey, type DriftFinding } from "@/lib/admin/drift";
import type { RecheckResult } from "@/lib/admin/recheck";
import { bigintReplacer } from "@/lib/diagnostics/bundle";
import { csvCell } from "@/lib/portfolio/export-csv";

const ACTOR_KEYS = new Set([
  "actor",
  "ackedBy",
  "acknowledgedBy",
  "assignedBy",
  "operator",
  "walletAddress",
]);

function redactActors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactActors);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = ACTOR_KEYS.has(key) ? "[redacted]" : redactActors(entry);
    }
    return out;
  }
  return value;
}

function exact(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "object") return JSON.stringify(redactActors(value), bigintReplacer);
  return String(value);
}

export function exportFindingsCsv(
  findings: readonly DriftFinding[],
  recheck: ReadonlyMap<string, RecheckResult>,
): string {
  const header = [
    "id",
    "runId",
    "marketId",
    "onChainMarketId",
    "driftClass",
    "action",
    "dbValue",
    "chainValue",
    "observedLedger",
    "createdAt",
    "recheckStatus",
    "recheckDetail",
  ];
  const rows = findings.map((finding, index) => {
    const check = recheck.get(findingKey(finding, index));
    return [
      exact(finding.id),
      exact(finding.runId),
      exact(finding.marketId),
      exact(finding.onChainMarketId),
      exact(finding.driftClass),
      exact(finding.action),
      exact(finding.dbValue),
      exact(finding.chainValue),
      exact(finding.observedLedger),
      exact(finding.createdAt),
      check ? exact(check.status) : "",
      check && "detail" in check ? exact(check.detail) : check && "reason" in check ? exact(check.reason) : "",
    ].map((cell) => csvCell(cell)).join(",");
  });
  return [header.map((cell) => csvCell(cell)).join(","), ...rows].join("\r\n");
}

export function exportFindingsJson(
  findings: readonly DriftFinding[],
  recheck: ReadonlyMap<string, RecheckResult>,
): string {
  const payload = redactActors({
    exportedAt: new Date().toISOString(),
    findings: findings.map((finding, index) => ({
      ...finding,
      recheck: recheck.get(findingKey(finding, index)) ?? null,
    })),
  });
  return JSON.stringify(payload, bigintReplacer, 2);
}

export function downloadTextFile(filename: string, contents: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
