import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  isAdminIdentity,
  isDevelopmentAdminFallbackActive,
  getDevelopmentFallbackPermissions,
} from "../permissions-types";

describe("Admin Permissions & RBAC Types", () => {
  it("includes all required permissions in ADMIN_PERMISSIONS constant", () => {
    expect(ADMIN_PERMISSIONS).toContain("admin.read");
    expect(ADMIN_PERMISSIONS).toContain("admin.manage");
    expect(ADMIN_PERMISSIONS).toContain("admin.audit.read");
    expect(ADMIN_PERMISSIONS).toContain("markets.generate");
    expect(ADMIN_PERMISSIONS).toContain("treasury.read");
    expect(ADMIN_PERMISSIONS).toContain("treasury.operate");
    expect(ADMIN_PERMISSIONS).toContain("agents.manage");
    expect(ADMIN_PERMISSIONS).toContain("disputes.manage");
    expect(ADMIN_PERMISSIONS).toContain("trace_audit.run");
    expect(ADMIN_PERMISSIONS).toContain("reconciliation.run");
    expect(ADMIN_PERMISSIONS).toContain("calibration.recompute");
    expect(ADMIN_PERMISSIONS).toContain("refund.prepare");
    expect(ADMIN_PERMISSIONS).toContain("refund.review");
    expect(ADMIN_PERMISSIONS).toContain("refund.execute");
    expect(ADMIN_PERMISSIONS).toContain("refund.cancel");
  });

  describe("isAdminIdentity", () => {
    it("accepts valid Ed25519 G... accounts", () => {
      // Well-known valid test address
      const validG = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
      expect(isAdminIdentity(validG)).toBe(true);
    });

    it("rejects contract (C...) accounts", () => {
      const contractC = "CAFEED35XICK4OXIEXQDS6KTTBUA2LDNW3EXEUGTNMN54DY5ANETCH6M";
      expect(isAdminIdentity(contractC)).toBe(false);
    });

    it("rejects muxed (M...) accounts and null/undefined", () => {
      expect(isAdminIdentity("MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK")).toBe(false);
      expect(isAdminIdentity(null)).toBe(false);
      expect(isAdminIdentity(undefined)).toBe(false);
      expect(isAdminIdentity("")).toBe(false);
      expect(isAdminIdentity("not-an-address")).toBe(false);
    });
  });

  describe("Development fallback behavior", () => {
    it("is strictly disabled when NODE_ENV is production", () => {
      const origEnv = process.env.NODE_ENV;
      const origFallback = process.env.NEXT_PUBLIC_ADMIN_FALLBACK;

      try {
        (process.env as any).NODE_ENV = "production";
        process.env.NEXT_PUBLIC_ADMIN_FALLBACK = "true";

        expect(isDevelopmentAdminFallbackActive()).toBe(false);
      } finally {
        (process.env as any).NODE_ENV = origEnv;
        process.env.NEXT_PUBLIC_ADMIN_FALLBACK = origFallback;
      }
    });

    it("activates only in non-production with NEXT_PUBLIC_ADMIN_FALLBACK=true", () => {
      const origEnv = process.env.NODE_ENV;
      const origFallback = process.env.NEXT_PUBLIC_ADMIN_FALLBACK;

      try {
        (process.env as any).NODE_ENV = "development";
        process.env.NEXT_PUBLIC_ADMIN_FALLBACK = "true";

        expect(isDevelopmentAdminFallbackActive()).toBe(true);
      } finally {
        (process.env as any).NODE_ENV = origEnv;
        process.env.NEXT_PUBLIC_ADMIN_FALLBACK = origFallback;
      }
    });
  });
});
