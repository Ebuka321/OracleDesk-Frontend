import { describe, expect, it, vi } from "vitest";
import { apiClient, registerStepUpHandler, ApiError } from "../client";

describe("Step-Up Authentication & 403 handling", () => {
  it("handles 403 STEP_UP_REQUIRED by prompting stepUpHandler and retrying once", async () => {
    let callCount = 0;
    const stepUpMock = vi.fn().mockResolvedValue(true);
    const unregister = registerStepUpHandler(stepUpMock);

    // Mock global fetch for this test
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Return 403 with STEP_UP_REQUIRED
        return new Response(
          JSON.stringify({
            ok: false,
            data: null,
            error: {
              code: "STEP_UP_REQUIRED",
              message: "Recent wallet signature required for administrative action",
              details: { maxAgeSeconds: 300, reauthenticate: true },
            },
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
      // Second call (retry) succeeds
      return new Response(
        JSON.stringify({
          ok: true,
          data: { success: true },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      const res = await apiClient.post("/admin/admins/grant", { walletAddress: "GA", roleName: "admin" });
      expect(stepUpMock).toHaveBeenCalledTimes(1);
      expect(callCount).toBe(2);
      expect(res.data).toEqual({ success: true });
    } finally {
      global.fetch = origFetch;
      unregister();
    }
  });

  it("does not loop if user cancels step-up prompt", async () => {
    let callCount = 0;
    const stepUpMock = vi.fn().mockResolvedValue(false); // User cancels
    const unregister = registerStepUpHandler(stepUpMock);

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          ok: false,
          data: null,
          error: {
            code: "STEP_UP_REQUIRED",
            message: "Step-up cancelled",
            details: { maxAgeSeconds: 300, reauthenticate: true },
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    });

    try {
      await expect(
        apiClient.post("/admin/admins/grant", { walletAddress: "GA", roleName: "admin" }),
      ).rejects.toThrow();
      expect(stepUpMock).toHaveBeenCalledTimes(1);
      expect(callCount).toBe(1); // Never retried after cancel
    } finally {
      global.fetch = origFetch;
      unregister();
    }
  });
});
