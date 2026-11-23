import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { userMessage } from "../display";

describe("ApiError catalog integration", () => {
  it("ApiError message comes from catalog not server", () => {
    const rawServerString = "internal backend error message that should never be shown to user";
    const err = new ApiError(
      {
        code: "INVALID_ADDRESS",
        message: rawServerString,
      },
      400,
    );

    expect(err.errorCode).toBe("api.INVALID_ADDRESS");
    expect(err.code).toBe("INVALID_ADDRESS");
    expect(err.message).toBe("The provided wallet address is invalid.");
    expect(err.serverMessage).toBe(rawServerString);
    expect(userMessage(err)).toBe("The provided wallet address is invalid.");
  });

  it("unknown code maps to HTTP_UNKNOWN and preserves serverMessage", () => {
    const rawMsg = "Custom internal failure 500";
    const err = new ApiError(
      {
        code: "STRANGE_INTERNAL_CODE",
        message: rawMsg,
      },
      500,
    );

    expect(err.errorCode).toBe("api.HTTP_UNKNOWN");
    expect(err.code).toBe("STRANGE_INTERNAL_CODE");
    expect(err.message).toBe("An unexpected server error occurred.");
    expect(err.serverMessage).toBe(rawMsg);
    expect(userMessage(err)).toBe("An unexpected server error occurred.");
  });

  it("BACKEND_UNREACHABLE uses catalog message and does not expose API_URL", () => {
    const err = new ApiError(
      {
        code: "BACKEND_UNREACHABLE",
        message: "Network failure",
      },
      0,
    );

    expect(err.errorCode).toBe("api.BACKEND_UNREACHABLE");
    expect(err.message).toBe("Couldn't reach the backend. Check your connection and try again.");
    expect(err.message).not.toContain("http");
    expect(userMessage(err)).toBe("Couldn't reach the backend. Check your connection and try again.");
  });

  it("RATE_LIMITED interpolates retryAfterSeconds parameter", () => {
    const err = new ApiError(
      {
        code: "RATE_LIMITED",
        message: "Slow down",
      },
      429,
      12,
    );

    expect(err.errorCode).toBe("api.RATE_LIMITED");
    expect(err.message).toBe("Too many requests. Try again in 12 seconds.");
    expect(userMessage(err)).toBe("Too many requests. Try again in 12 seconds.");
  });

  it("handles numbers and strings in constructors", () => {
    const err = new ApiError(404, "MARKET_NOT_FOUND", "Market not in DB");
    expect(err.errorCode).toBe("api.MARKET_NOT_FOUND");
    expect(err.message).toBe("The requested market was not found.");
    expect(err.serverMessage).toBe("Market not in DB");
  });
});
