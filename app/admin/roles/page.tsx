"use client";

import React, { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { RequireWallet } from "@/components/require-wallet";
import { useWallet } from "@/lib/contexts/WalletContext";
import { useAdminPermissions } from "@/lib/admin/useAdminPermissions";
import {
  type AdminPermission,
  type BackendRole,
  type BackendAdminAssignment,
  ADMIN_PERMISSIONS,
  isAdminIdentity,
} from "@/lib/admin/permissions-types";
import { apiClient, ApiError } from "@/lib/api/client";
import { useQuery } from "@tanstack/react-query";
import { userKeys } from "@/lib/query/keys";
import { useUserScope } from "@/lib/query/scope";
import { useScopedMutation } from "@/lib/query/useScopedMutation";

export default function AdminRolesPage() {
  return (
    <RequireWallet
      title="Restricted Access"
      description="Administrative Role-Based Access Control requires an authenticated admin wallet connection."
    >
      <AdminRolesContent />
    </RequireWallet>
  );
}

function AdminRolesContent() {
  const { address, withSession } = useWallet();
  const scope = useUserScope();
  const { can, role: myRole, isLoading: isPermissionsLoading, isDevelopmentFallback, refetch: refreshPermissions } = useAdminPermissions();

  const [targetAddress, setTargetAddress] = useState("");
  const [targetRole, setTargetRole] = useState("admin");
  const [actionError, setActionError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Review & Confirmation state
  const [pendingAction, setPendingAction] = useState<{
    type: "grant" | "revoke";
    walletAddress: string;
    roleName?: string;
    isSelfRevoke?: boolean;
    isLastSuperAdmin?: boolean;
  } | null>(null);

  // GET /admin/roles
  const rolesQuery = useQuery({
    queryKey: userKeys.adminRoles(scope),
    queryFn: async () => {
      const res = await apiClient.get<BackendRole[]>("/admin/roles", undefined, { expectScope: scope });
      return res.data;
    },
    enabled: Boolean(scope.wallet) && can("admin.read"),
  });

  // GET /admin/admins
  const adminsQuery = useQuery({
    queryKey: userKeys.adminAdmins(scope),
    queryFn: async () => {
      const res = await apiClient.get<BackendAdminAssignment[]>("/admin/admins", undefined, { expectScope: scope });
      return res.data;
    },
    enabled: Boolean(scope.wallet) && can("admin.read"),
  });

  const roles = rolesQuery.data ?? [];
  const admins = adminsQuery.data ?? [];

  // Scoped mutation for Grant
  const grantMutation = useScopedMutation(
    ({ walletAddress, roleName }: { walletAddress: string; roleName: string }, options) =>
      apiClient.post("/admin/admins/grant", { walletAddress, roleName }, undefined, options),
    async () => {
      await Promise.all([rolesQuery.refetch(), adminsQuery.refetch(), refreshPermissions()]);
    },
  );

  // Scoped mutation for Revoke
  const revokeMutation = useScopedMutation(
    ({ walletAddress }: { walletAddress: string }, options) =>
      apiClient.post("/admin/admins/revoke", { walletAddress }, undefined, options),
    async () => {
      await Promise.all([rolesQuery.refetch(), adminsQuery.refetch(), refreshPermissions()]);
    },
  );

  const selectedRoleObj = roles.find((r) => r.name === targetRole);

  const handleInitiateGrant = (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    setSuccessMessage(null);

    const trimmed = targetAddress.trim();
    if (!isAdminIdentity(trimmed)) {
      setActionError("Invalid admin address. Only valid Ed25519 G... accounts are eligible. Contract (C...) and muxed (M...) addresses cannot be admins.");
      return;
    }

    setPendingAction({
      type: "grant",
      walletAddress: trimmed,
      roleName: targetRole,
    });
  };

  const handleInitiateRevoke = (adminToRevoke: BackendAdminAssignment) => {
    setActionError(null);
    setSuccessMessage(null);

    const isSelfRevoke = adminToRevoke.walletAddress === address;
    const superAdmins = admins.filter((a) => a.roleName === "super_admin");
    const isLastSuperAdmin = adminToRevoke.roleName === "super_admin" && superAdmins.length <= 1;

    setPendingAction({
      type: "revoke",
      walletAddress: adminToRevoke.walletAddress,
      roleName: adminToRevoke.roleName,
      isSelfRevoke,
      isLastSuperAdmin,
    });
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    setActionError(null);
    setSuccessMessage(null);

    try {
      if (pendingAction.type === "grant") {
        await withSession(
          () =>
            grantMutation.mutateAsync({
              walletAddress: pendingAction.walletAddress,
              roleName: pendingAction.roleName!,
            }),
          `grant role ${pendingAction.roleName} to ${pendingAction.walletAddress}`,
        );
        setSuccessMessage(`Successfully granted role ${pendingAction.roleName} to ${pendingAction.walletAddress}`);
        setTargetAddress("");
      } else {
        await withSession(
          () =>
            revokeMutation.mutateAsync({
              walletAddress: pendingAction.walletAddress,
            }),
          `revoke admin role from ${pendingAction.walletAddress}`,
        );
        setSuccessMessage(`Successfully revoked role from ${pendingAction.walletAddress}`);
      }
      setPendingAction(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          void refreshPermissions();
        }
        setActionError(err.serverMessage || err.message);
      } else {
        setActionError(err instanceof Error ? err.message : "Action failed");
      }
    }
  };

  if (isPermissionsLoading) {
    return (
      <main className="flex-grow flex items-center justify-center p-gutter">
        <div className="p-8 text-center text-on-surface-variant font-label-caps animate-pulse">
          Resolving administrative authorization…
        </div>
      </main>
    );
  }

  // Gate on admin.read
  if (!can("admin.read")) {
    return (
      <main className="flex-grow flex items-center justify-center p-gutter">
        <div className="max-w-md w-full text-center space-y-4 bg-white p-10 rounded-xl border border-outline-variant shadow-sm">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <Icon name="block" className="text-3xl" />
          </div>
          <h2 className="font-headline-md text-headline-md">Access Denied</h2>
          <p className="text-on-surface-variant">Only administrators with admin.read permission can view roles and permissions.</p>
          <p className="text-on-surface-variant text-sm font-data-mono break-all">{address}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-grow max-w-container-max-width mx-auto px-gutter py-12 w-full space-y-8">
      {isDevelopmentFallback && (
        <div role="note" className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-700 text-xs flex items-center gap-2">
          <Icon name="warning" className="text-sm" />
          <span>DEVELOPMENT FALLBACK: Gated by local environment addresses, not real backend authorization. Never active in production.</span>
        </div>
      )}

      {/* Breadcrumb & Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-on-surface-variant text-xs">
            <Link href="/admin" className="hover:text-primary">Admin</Link>
            <Icon name="chevron_right" className="text-xs" />
            <span>Roles &amp; Access</span>
          </div>
          <h1 className="font-display-lg text-display-lg text-primary text-4xl">Roles &amp; Permissions</h1>
          <p className="text-on-surface-variant font-body-lg text-body-lg">
            Manage administrative privileges, assign backend RBAC roles, and audit permissions.
          </p>
        </div>
        {myRole && (
          <div className="bg-primary/10 border border-primary/20 px-4 py-2 rounded-lg text-xs font-label-caps">
            <span className="text-on-surface-variant block">YOUR ACTIVE ROLE:</span>
            <span className="font-bold text-primary text-sm uppercase">{myRole}</span>
          </div>
        )}
      </div>

      {actionError && (
        <div role="alert" className="p-4 bg-error-container/20 border border-error rounded-xl text-error text-sm flex items-center gap-2">
          <Icon name="error" className="text-base" />
          <span>{actionError}</span>
        </div>
      )}

      {successMessage && (
        <div role="status" className="p-4 bg-secondary-container/20 border border-secondary rounded-xl text-secondary text-sm flex items-center gap-2">
          <Icon name="check_circle" className="text-base" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Confirmation Modal / Review Dialog */}
      {pendingAction && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-outline-variant max-w-lg w-full p-6 space-y-4 shadow-xl">
            <h3 className="font-headline-sm text-headline-sm flex items-center gap-2">
              <Icon name="warning" className="text-amber-500" />
              Confirm {pendingAction.type === "grant" ? "Role Grant" : "Role Revocation"}
            </h3>

            {pendingAction.isSelfRevoke && (
              <div role="alert" className="p-3 bg-error-container/20 border border-error rounded-lg text-error text-xs flex items-start gap-2">
                <Icon name="warning" className="text-base shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">CRITICAL WARNING: </span>
                  You are about to revoke your own administrative privileges! You will immediately lose access to the Admin area.
                </div>
              </div>
            )}

            {pendingAction.isLastSuperAdmin && (
              <div role="alert" className="p-3 bg-error-container/20 border border-error rounded-lg text-error text-xs flex items-start gap-2">
                <Icon name="error" className="text-base shrink-0 mt-0.5" />
                <div>
                  <span className="font-bold">CAUTION: </span>
                  This is the last remaining super_admin. The backend will refuse this revocation to avoid protocol lockout.
                </div>
              </div>
            )}

            <div className="space-y-2 text-sm text-on-surface-variant">
              <p>
                <strong>Target Account:</strong>{" "}
                <code className="font-data-mono text-xs break-all text-on-surface">{pendingAction.walletAddress}</code>
              </p>
              {pendingAction.type === "grant" && (
                <>
                  <p>
                    <strong>Assigned Role:</strong> <span className="font-bold text-on-surface uppercase">{pendingAction.roleName}</span>
                  </p>
                  <div className="p-3 bg-surface-container rounded-lg text-xs">
                    <span className="font-bold block mb-1">Permissions this role grants:</span>
                    <ul className="list-disc list-inside space-y-0.5 font-data-mono">
                      {roles.find((r) => r.name === pendingAction.roleName)?.permissions.map((p) => (
                        <li key={p}>{p}</li>
                      )) ?? <li>None</li>}
                    </ul>
                  </div>
                </>
              )}
            </div>

            <p className="text-xs text-on-surface-variant italic">
              Step-up authentication is required: your Stellar wallet will prompt you to sign a verification challenge.
            </p>

            <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="px-4 py-2 border border-outline rounded-lg text-xs font-label-caps hover:bg-surface-container transition-colors"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmAction()}
                disabled={grantMutation.isPending || revokeMutation.isPending}
                className={`px-4 py-2 rounded-lg text-xs font-label-caps text-white transition-colors ${
                  pendingAction.type === "revoke" ? "bg-error hover:bg-error/90" : "bg-primary hover:bg-primary/90"
                }`}
              >
                {grantMutation.isPending || revokeMutation.isPending ? "CONFIRMING WITH WALLET…" : "CONFIRM WITH WALLET"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Grant Form (gated on admin.manage) */}
      {can("admin.manage") && (
        <section className="bg-white border border-outline-variant rounded-xl p-6 shadow-sm space-y-4">
          <h2 className="font-headline-sm text-headline-sm flex items-center gap-2">
            <Icon name="person_add" className="text-primary text-xl" />
            Grant Admin Role
          </h2>
          <form onSubmit={handleInitiateGrant} className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            <div className="md:col-span-6 space-y-1">
              <label className="font-label-caps text-label-caps text-on-surface-variant block">
                ADMIN WALLET ADDRESS (G… STRKEY)
              </label>
              <input
                type="text"
                value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                placeholder="G..."
                className="w-full bg-surface border border-outline-variant rounded p-2.5 font-data-mono text-xs outline-none focus:ring-2 focus:ring-primary"
                required
              />
            </div>

            <div className="md:col-span-4 space-y-1">
              <label className="font-label-caps text-label-caps text-on-surface-variant block">
                ROLE
              </label>
              <select
                value={targetRole}
                onChange={(e) => setTargetRole(e.target.value)}
                className="w-full bg-surface border border-outline-variant rounded p-2.5 text-xs outline-none focus:ring-2 focus:ring-primary"
              >
                {roles.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name} ({r.permissions.length} perms)
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                className="w-full bg-primary text-primary-foreground py-2.5 px-4 rounded-lg font-label-caps text-label-caps hover:brightness-110 active:scale-[0.98] transition-all"
              >
                ASSIGN ROLE
              </button>
            </div>
          </form>

          {selectedRoleObj && (
            <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant text-xs space-y-1">
              <span className="font-bold text-on-surface">Permissions preview for &apos;{selectedRoleObj.name}&apos;:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {selectedRoleObj.permissions.map((p) => (
                  <span key={p} className="bg-surface border border-outline-variant px-1.5 py-0.5 rounded text-[10px] font-data-mono">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Current Administrators Table */}
      <section className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="p-5 border-b border-outline-variant flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm">Active Administrator Assignments</h2>
          <span className="text-xs text-on-surface-variant font-data-mono">{admins.length} assigned</span>
        </div>

        {adminsQuery.isLoading ? (
          <p className="p-8 text-center text-on-surface-variant animate-pulse">Loading admin assignments…</p>
        ) : admins.length === 0 ? (
          <p className="p-8 text-center text-on-surface-variant italic">No administrator assignments found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-container-low text-on-surface-variant text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-3">Wallet Address</th>
                  <th className="px-4 py-3">Assigned Role</th>
                  <th className="px-4 py-3">Assigned Date</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {admins.map((adm) => {
                  const isMe = adm.walletAddress === address;
                  return (
                    <tr key={adm.walletAddress} className="align-middle">
                      <td className="px-4 py-3 font-data-mono text-xs break-all">
                        {adm.walletAddress}
                        {isMe && <span className="ml-2 text-primary font-bold">(You)</span>}
                      </td>
                      <td className="px-4 py-3 font-bold text-xs uppercase text-on-surface">
                        {adm.roleName}
                      </td>
                      <td className="px-4 py-3 text-xs text-on-surface-variant">
                        {adm.assignedAt ? new Date(adm.assignedAt).toLocaleDateString() : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {can("admin.manage") ? (
                          <button
                            type="button"
                            onClick={() => handleInitiateRevoke(adm)}
                            className="text-xs text-error underline hover:text-error/80 disabled:opacity-50"
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="text-xs text-on-surface-variant">Read-only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Available Roles & Permissions Reference */}
      <section className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="p-5 border-b border-outline-variant">
          <h2 className="font-headline-sm text-headline-sm">Roles &amp; Permissions Directory</h2>
          <p className="text-xs text-on-surface-variant mt-1">
            Backend RBAC role definitions and permission mappings.
          </p>
        </div>
        <div className="divide-y divide-outline-variant">
          {roles.map((r) => (
            <div key={r.name} className="p-5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-sm text-on-surface uppercase">{r.name}</span>
                <span className="text-xs text-on-surface-variant font-data-mono">{r.permissions.length} permissions</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.permissions.map((p) => (
                  <span
                    key={p}
                    className="bg-surface-container px-2 py-0.5 rounded text-[11px] font-data-mono text-on-surface border border-outline-variant"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
