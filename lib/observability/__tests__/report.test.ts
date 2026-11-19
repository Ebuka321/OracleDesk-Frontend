import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RedactedEvent, ReportTransport } from "../report";

const G_ADDRESS = "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ";

interface LoadedReport {
  reportError: typeof import("../report").reportError;
  reportMessage: typeof import("../report").reportMessage;
  initReporting: typeof import("../report").initReporting;
  setReportingConsent: typeof import("../report").setReportingConsent;
  getReportingConsent: typeof import("../report").getReportingConsent;
}

async function loadReporter(opts: { dsn?: string } = {}): Promise<{ report: LoadedReport; sent: RedactedEvent[] }> {
  vi.resetModules();
  const report = await import("../report");
  const sent: RedactedEvent[] = [];
  const transport: ReportTransport = {
    send: (event) => {
      sent.push(event);
      return Promise.resolve();
    },
  };
  report.initReporting({
    dsn: opts.dsn ?? "https://public@o1.ingest.example/42",
    release: "test-release",
    environment: "Stellar Testnet",
    transport,
  });
  return { report, sent };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("error reporting (Issue #123)", () => {
  it("is a no-op without a dsn but still returns a reference id", async () => {
    const { report, sent } = await loadReporter({ dsn: "" });
    report.setReportingConsent(true);
    const reference = report.reportError(new Error("boom"));
    expect(reference).toMatch(/^[A-Z2-7]{8}$/);
    expect(sent).toHaveLength(0);
  });

  it("is a no-op without consent", async () => {
    const { report, sent } = await loadReporter();
    expect(report.getReportingConsent()).toBe(false);
    report.reportError(new Error("boom"));
    expect(sent).toHaveLength(0);
  });

  it("sends a redacted event once consent is granted", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    report.reportError(new Error(`boom from ${G_ADDRESS}`), { feature: "buy", contract: "marketCore" });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain("boom from");
    expect(sent[0].message).not.toContain(G_ADDRESS);
    expect(sent[0].tags.feature).toBe("buy");
    expect(sent[0].release).toBe("test-release");
    expect(sent[0].environment).toBe("Stellar Testnet");
    expect(typeof sent[0].route).toBe("string");
  });

  it("honours Do Not Track over a granted consent", async () => {
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    expect(report.getReportingConsent()).toBe(false);
    report.reportError(new Error("boom"));
    expect(sent).toHaveLength(0);
  });

  it("extracts UserFacingError kind, code and contract", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    const { UserFacingError } = await import("@/lib/stellar/errors");
    report.reportError(
      new UserFacingError({ kind: "contract", code: "SlippageExceeded", message: "price moved" }),
      { feature: "buy", contract: "marketCore" },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("contract");
    expect(sent[0].code).toBe("SlippageExceeded");
    expect(sent[0].contract).toBe("marketCore");
  });

  it("extracts ApiError code and status", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    const { ApiError } = await import("@/lib/api/client");
    report.reportError(new ApiError({ code: "BACKEND_UNREACHABLE", message: "offline" }, 0), {
      feature: "premium",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].apiCode).toBe("BACKEND_UNREACHABLE");
    expect(sent[0].httpStatus).toBe(0);
  });

  it("does not report a rejected signature", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    const { UserFacingError } = await import("@/lib/stellar/errors");
    report.reportError(new UserFacingError({ kind: "rejected", message: "you cancelled" }));
    expect(sent).toHaveLength(0);
  });

  it("rate-limits to 10 events per minute", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    for (let i = 0; i < 12; i++) report.reportError(new Error(`boom ${i}`));
    expect(sent).toHaveLength(10);
  });

  it("sends identical failures only once per dedupe window", async () => {
    const { report, sent } = await loadReporter();
    report.setReportingConsent(true);
    report.reportError(new Error("same failure"));
    report.reportError(new Error("same failure"));
    expect(sent).toHaveLength(1);
  });

  it("returns a reference id when reporting is disabled", async () => {
    const { report } = await loadReporter({ dsn: "" });
    const reference = report.reportError(new Error("boom"));
    expect(reference).toMatch(/^[A-Z2-7]{8}$/);
    expect(reference).toHaveLength(8);
  });
});
