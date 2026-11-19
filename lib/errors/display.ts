import { messageFor } from "./messages";
import { describeError, UserFacingError } from "@/lib/stellar/errors";
import { ApiError } from "@/lib/api/client";

/**
 * Returns a stable, localized, user-appropriate error message for any error.
 * Extracts stable errorCodes from UserFacingError and ApiError, otherwise delegates
 * to describeError.
 */
export function userMessage(err: unknown): string {
  if (err instanceof UserFacingError) {
    if (err.described.errorCode) {
      return messageFor(err.described.errorCode, err.described.params);
    }
    return err.described.message;
  }

  if (err instanceof ApiError) {
    const params: Record<string, string | number> =
      typeof err.details === "object" && err.details ? { ...(err.details as Record<string, string | number>) } : {};
    if (err.retryAfterSeconds !== undefined && params.seconds === undefined) {
      params.seconds = err.retryAfterSeconds;
    }
    return messageFor(err.errorCode, params);
  }

  // Duck typing for errors crossing boundaries
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj.name === "UserFacingError" && obj.described && typeof obj.described === "object") {
      const desc = obj.described as { errorCode?: string; params?: Record<string, string | number>; message?: string };
      if (desc.errorCode) {
        return messageFor(desc.errorCode, desc.params);
      }
      if (desc.message) return desc.message;
    }
    if (obj.name === "ApiError" && typeof obj.errorCode === "string") {
      const params: Record<string, string | number> =
        typeof obj.details === "object" && obj.details ? { ...(obj.details as Record<string, string | number>) } : {};
      if (typeof obj.retryAfterSeconds === "number" && params.seconds === undefined) {
        params.seconds = obj.retryAfterSeconds;
      }
      return messageFor(obj.errorCode, params);
    }
  }

  return describeError(err).message;
}
