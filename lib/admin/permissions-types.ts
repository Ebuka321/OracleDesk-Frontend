import { StrKey } from "@stellar/stellar-sdk";
import { ADMIN_ADDRESSES } from "@/lib/stellar/config";

/**
 * Backend RBAC Permission Names
 * Kept in one typed constant and union type.
 */
export const ADMIN_PERMISSIONS = [
  "admin.read",
  "admin.manage",
  "admin.audit.read",
  "markets.generate",
  "treasury.read",
  "treasury.operate",
  "agents.manage",
  "disputes.manage",
  "trace_audit.run",
  "reconciliation.run",
  "calibration.recompute",
  "refund.prepare",
  "refund.review",
  "refund.execute",
  "refund.cancel",
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export interface BackendRole {
  name: string;
  permissions: AdminPermission[];
  adminCount?: number;
  description?: string;
}

export interface BackendAdminAssignment {
  walletAddress: string;
  roleName: string;
  assignedAt?: string;
  assignedBy?: string;
}

/**
 * Contract (C...) accounts, muxed addresses (M...), and invalid identities
 * can NEVER be admins. Only valid standard Ed25519 G... accounts are eligible.
 */
export function isAdminIdentity(address: string | null | undefined): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  if (!trimmed.startsWith("G") || trimmed.length !== 56) return false;
  try {
    return StrKey.isValidEd25519PublicKey(trimmed);
  } catch {
    return false;
  }
}

/**
 * Development fallback flag:
 * Active ONLY when NEXT_PUBLIC_ADMIN_FALLBACK=true AND process.env.NODE_ENV !== "production".
 * NEVER enabled in production builds.
 */
export function isDevelopmentAdminFallbackActive(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const fallbackEnv = process.env.NEXT_PUBLIC_ADMIN_FALLBACK;
  return fallbackEnv === "true" || fallbackEnv === "1";
}

/**
 * Fallback permissions for development when env allowlist is active in non-production.
 */
export function getDevelopmentFallbackPermissions(address: string | null | undefined): {
  role: string | null;
  permissions: Set<AdminPermission>;
  isFallback: boolean;
} {
  if (!isDevelopmentAdminFallbackActive() || !isAdminIdentity(address)) {
    return { role: null, permissions: new Set(), isFallback: false };
  }

  if (address && ADMIN_ADDRESSES.includes(address)) {
    // In dev fallback mode, grant all permissions so developer can test all admin features
    return {
      role: "super_admin (dev fallback)",
      permissions: new Set(ADMIN_PERMISSIONS),
      isFallback: true,
    };
  }

  return { role: null, permissions: new Set(), isFallback: false };
}
