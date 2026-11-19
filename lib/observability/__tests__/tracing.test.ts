import { afterEach, describe, expect, it, vi } from "vitest";
import {
  childSpan,
  currentOperation,
  currentTrace,
  formatErrorWithReference,
  newTrace,
  parseTraceparent,
  sanitizeSpanAttributes,
  setSpanSink,
  setSpanAttribute,
  shouldSample,
  shortRef,
  toTraceparent,
  withOperation,
} from "../tracing";
import { UserFacingError } from "@/lib/stellar/errors";

afterEach(() => {
  setSpanSink(null);
});

describe("trace context (Issue #124)", () => {
  it("builds a spec-valid traceparent", () => {
    const ctx = newTrace();
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.traceId).not.toBe("0".repeat(32));
    const header = toTraceparent(ctx);
    expect(header).toBe(`00-${ctx.traceId}-${ctx.spanId}-01`);
    expect(parseTraceparent(header)).toEqual(ctx);
  });

  it("marks unsampled contexts with flag 00", () => {
    const ctx = newTrace(false);
    expect(toTraceparent(ctx).endsWith("-00")).toBe(true);
    expect(parseTraceparent(toTraceparent(ctx))?.sampled).toBe(false);
  });

  it("rejects malformed and all-zero traceparents", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-00000000000000000000000000000000-0000000000000001-01")).toBeNull();
    // Wrong version and short ids.
    expect(parseTraceparent("01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")).toBeNull();
    expect(parseTraceparent("00-abc-bbb-01")).toBeNull();
  });

  it("keeps the trace id in child spans", () => {
    const parent = newTrace();
    const child = childSpan(parent);
    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.sampled).toBe(parent.sampled);
  });

  it("shortens a trace id to 8 characters for references", () => {
    const ctx = newTrace();
    expect(shortRef(ctx.traceId)).toHaveLength(8);
    expect(ctx.traceId.startsWith(shortRef(ctx.traceId))).toBe(true);
  });
});

describe("withOperation (Issue #124)", () => {
  it("exposes the active trace inside the operation only", async () => {
    expect(currentTrace()).toBeNull();
    const seen = await withOperation("sign-in", async (ctx) => {
      expect(currentTrace()).toEqual(ctx);
      expect(currentOperation()?.name).toBe("sign-in");
      return ctx.traceId;
    });
    expect(currentTrace()).toBeNull();
    expect(seen).toMatch(/^[0-9a-f]{32}$/);
  });

  it("nests a child span in the same trace", async () => {
    await withOperation("copy-trade", async (outer) => {
      await withOperation("sign-in", async (inner) => {
        expect(inner.traceId).toBe(outer.traceId);
        expect(inner.spanId).not.toBe(outer.spanId);
      });
      expect(currentTrace()).toEqual(outer);
    });
  });

  it("pops the operation even when the body throws", async () => {
    await expect(
      withOperation("premium-unlock", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(currentTrace()).toBeNull();
    expect(currentOperation()).toBeNull();
  });

  it("records span attributes on the active operation", async () => {
    await withOperation("premium-unlock", async () => {
      setSpanAttribute("payment.tx_hash", "abc123");
      expect(currentOperation()?.attrs["payment.tx_hash"]).toBe("abc123");
    });
    // No active operation: no throw, no state.
    expect(() => setSpanAttribute("x", 1)).not.toThrow();
  });

  it("starts a fresh trace per top-level operation", async () => {
    const first = await withOperation("generate-market", (ctx) => Promise.resolve(ctx.traceId));
    const second = await withOperation("generate-market", (ctx) => Promise.resolve(ctx.traceId));
    expect(first).not.toBe(second);
  });
});

describe("formatErrorWithReference (Issue #124)", () => {
  it("appends the reference to the message", () => {
    expect(formatErrorWithReference(new Error("payment failed"), "4bf92f3575b44312b56bdb9b0c0d2c5c")).toBe(
      "payment failed Reference: 4bf92f35",
    );
  });

  it("prefers a requestId already on the error", () => {
    const err = new Error("backend exploded") as Error & { requestId: string };
    err.requestId = "aabbccdd11223344";
    expect(formatErrorWithReference(err)).toBe("backend exploded Reference: aabbccdd");
  });

  it("stringifies non-errors", () => {
    expect(formatErrorWithReference("plain failure", "deadbeef")).toBe("plain failure Reference: deadbeef");
  });

  it("leaves the message alone without any reference", () => {
    expect(formatErrorWithReference(new Error("no ref"))).toBe("no ref");
  });

  it("works with UserFacingError.withReference", () => {
    const err = new UserFacingError({ kind: "contract", code: "SlippageExceeded", message: "price moved" });
    err.withReference("4bf92f35");
    expect(err.message).toBe("price moved Reference: 4bf92f35");
    expect(err.reference).toBe("4bf92f35");
    // Idempotent: a second call does not double-append.
    err.withReference("another");
    expect(err.message).toBe("price moved Reference: 4bf92f35");
  });
});

describe("sanitizeSpanAttributes (Issue #124)", () => {
  it("drops sensitive keys", () => {
    const attrs = sanitizeSpanAttributes({
      "rpc.method": "getLedgerEntries",
      holder: "GABC",
      authorization: "Bearer x",
      xdr: "AAAA",
      "http.status_code": 200,
    });
    expect(attrs["rpc.method"]).toBe("getLedgerEntries");
    expect(attrs["http.status_code"]).toBe(200);
    expect(attrs.holder).toBeUndefined();
    expect(attrs.authorization).toBeUndefined();
    expect(attrs.xdr).toBeUndefined();
  });

  it("redacts StrKey, JWT and secret values", () => {
    const attrs = sanitizeSpanAttributes({
      note: "to GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ",
      auth: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef",
      seed: "S" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".repeat(2).slice(0, 55),
      ok: "plain value",
    });
    expect(attrs.note).toBe("[redacted]");
    expect(attrs.auth).toBe("[redacted]");
    expect(attrs.seed).toBe("[redacted]");
    expect(attrs.ok).toBe("plain value");
  });

  it("caps long strings and keeps booleans", () => {
    const attrs = sanitizeSpanAttributes({ long: "x".repeat(500), flag: true, n: 3 });
    expect(String(attrs.long).length).toBeLessThanOrEqual(201);
    expect(attrs.flag).toBe(true);
    expect(attrs.n).toBe(3);
  });
});

describe("shouldSample (Issue #124)", () => {
  it("always samples at 1 and never at 0", () => {
    expect(shouldSample("ffffffff000000000000000000000000", 1)).toBe(true);
    expect(shouldSample("00000000ffffffff0000000000000000", 0)).toBe(false);
  });

  it("is deterministic for a given id and rate", () => {
    const id = "4bf92f3575b44312b56bdb9b0c0d2c5c";
    const first = shouldSample(id, 0.5);
    expect(shouldSample(id, 0.5)).toBe(first);
    // Very low rates only ever drop.
    expect(shouldSample(id, 0)).toBe(false);
  });
});
