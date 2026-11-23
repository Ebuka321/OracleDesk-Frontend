import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiClient, apiPath } from "../client";

describe("apiPath", () => {
  it("encodes segments", () => {
    expect(apiPath`/markets/${"a b"}`).toBe("/markets/a%20b");
    expect(apiPath`/traces/${"x y"}`).toBe("/traces/x%20y");
  });

  it("rejects traversal and separators", () => {
    for (const value of ["", ".", "..", "%2e%2e", "a/b", "a\\b", "a%2Fb", "a%5Cb", "é"]) {
      expect(() => apiPath`/traces/${value}`).toThrow(ApiError);
    }
  });

  it("does not double-decode an encoded dot segment", () => {
    expect(apiPath`/traces/${"%252e%252e"}`).toBe("/traces/%25252e%25252e");
  });
});

describe("request path boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a path that escapes the API base before fetch is called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiClient.get("https://evil.example/steal")).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
