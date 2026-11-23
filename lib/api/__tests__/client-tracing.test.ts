import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClient, ApiError } from "../client";
import { withOperation } from "@/lib/observability/tracing";

/**
 * Issue #124: every backend request carries a traceparent and an
 * X-Request-Id derived from the same trace, and ApiError keeps the id so
 * the UI can show "Reference: <8 hex>" that matches backend logs.
 */

function lastHeaders(fetch: ReturnType<typeof vi.fn>): Headers {
  const call = fetch.mock.calls[fetch.mock.calls.length - 1];
  return new Headers((call[1] as RequestInit | undefined)?.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request tracing (Issue #124)", () => {
  it("sends a valid traceparent and a matching X-Request-Id", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { hello: "world" } }));
    vi.stubGlobal("fetch", fetch);

    await apiClient.get("/markets");

    const headers = lastHeaders(fetch);
    const traceparent = headers.get("traceparent");
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    const requestId = headers.get("x-request-id");
    expect(requestId).toHaveLength(8);
    expect(traceparent!.split("-")[1].startsWith(requestId!)).toBe(true);
  });

  it("reuses one trace for every request inside an operation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetch);

    await withOperation("sign-in", async () => {
      await apiClient.get("/auth/challenge");
      await apiClient.post("/auth/verify", { address: "G" });
    });

    const first = lastHeaders(fetch);
    expect(first.get("traceparent")).toBeTruthy();
    // Both requests of the operation share the trace id.
    const ids = fetch.mock.calls.map(
      (call) => new Headers((call[1] as RequestInit).headers).get("traceparent")!.split("-")[1],
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it("honours an explicit trace option over the ambient one", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetch);

    await apiClient.get("/markets", undefined, {
      trace: { traceId: "a".repeat(32), spanId: "b".repeat(16), sampled: true },
    });

    expect(lastHeaders(fetch).get("traceparent")).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    expect(lastHeaders(fetch).get("x-request-id")).toBe("aaaaaaaa");
  });

  it("puts the client trace id on ApiError for backend failures", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ ok: false, error: { code: "BACKEND_UNREACHABLE", message: "offline" } }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);

    const error = await apiClient.get("/markets").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const requestId = (error as ApiError).requestId;
    expect(requestId).toMatch(/^[0-9a-f]{8}$/);
    const sent = lastHeaders(fetch).get("x-request-id");
    expect(requestId).toBe(sent);
  });

  it("prefers the backend's echoed x-request-id when present", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        { ok: false, error: { code: "NOPE", message: "bad" } },
        { status: 400, headers: { "x-request-id": "server-id" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const error = (await apiClient.get("/markets").catch((e: unknown) => e)) as ApiError;
    expect(error.requestId).toBe("server-id");
  });

  it("keeps the client trace id when the backend is unreachable", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetch);

    const error = (await apiClient.get("/markets").catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("BACKEND_UNREACHABLE");
    expect(error.requestId).toMatch(/^[0-9a-f]{8}$/);
    expect(error.requestId).toBe(lastHeaders(fetch).get("x-request-id"));
  });

  it("does not overwrite a caller-supplied traceparent", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: null }));
    vi.stubGlobal("fetch", fetch);

    await apiClient.post(
      "/markets",
      { hello: "world" },
      { traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" },
    );

    expect(lastHeaders(fetch).get("traceparent")).toBe(
      "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
    );
  });
});
