"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { userKeys } from "@/lib/query/keys";
import { useUserScope } from "@/lib/query/scope";
import { useWallet } from "@/lib/contexts/WalletContext";
import {
  type AdminPermission,
  type BackendRole,
  type BackendAdminAssignment,
  isAdminIdentity,
  isDevelopmentAdminFallbackActive,
  getDevelopmentFallbackPermissions,
} from "./permissions-types";

export interface AdminPermissionsState {
  role: string | null;
  permissions: Set<AdminPermission>;
  can: (permission: AdminPermission) => boolean;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  isDevelopmentFallback: boolean;
  isEligibleAdminIdentity: boolean;
}

export function useAdminPermissions(): AdminPermissionsState {
  const { address } = useWallet();
  const scope = useUserScope();
  const queryClient = useQueryClient();

  const isEligible = isAdminIdentity(address);

  // GET /admin/roles
  const rolesQuery = useQuery({
    queryKey: userKeys.adminRoles(scope),
    queryFn: async () => {
      const res = await apiClient.get<BackendRole[]>("/admin/roles", undefined, { expectScope: scope });
      return res.data;
    },
    enabled: Boolean(scope.wallet) && isEligible,
    staleTime: 60_000,
    retry: false,
  });

  // GET /admin/admins
  const adminsQuery = useQuery({
    queryKey: userKeys.adminAdmins(scope),
    queryFn: async () => {
      const res = await apiClient.get<BackendAdminAssignment[]>("/admin/admins", undefined, { expectScope: scope });
      return res.data;
    },
    enabled: Boolean(scope.wallet) && isEligible,
    staleTime: 60_000,
    retry: false,
  });

  const refetch = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userKeys.adminRoles(scope) }),
      queryClient.invalidateQueries({ queryKey: userKeys.adminAdmins(scope) }),
    ]);
  };

  const resolved = useMemo(() => {
    // 1. Contract accounts (C...) or muxed accounts are never admins
    if (!isEligible || !address) {
      return {
        role: null,
        permissions: new Set<AdminPermission>(),
        isDevelopmentFallback: false,
      };
    }

    // 2. If development fallback is active (non-production + flag)
    if (isDevelopmentAdminFallbackActive()) {
      const fallback = getDevelopmentFallbackPermissions(address);
      if (fallback.isFallback) {
        return {
          role: fallback.role,
          permissions: fallback.permissions,
          isDevelopmentFallback: true,
        };
      }
    }

    // 3. Derive role and permissions from backend GET /admin/admins and GET /admin/roles
    const assignments = adminsQuery.data;
    const roles = rolesQuery.data;

    if (!assignments || !roles) {
      return {
        role: null,
        permissions: new Set<AdminPermission>(),
        isDevelopmentFallback: false,
      };
    }

    // Find the assignment matching the signed-in wallet
    const myAssignment = assignments.find((a) => a.walletAddress === address);
    if (!myAssignment) {
      return {
        role: null,
        permissions: new Set<AdminPermission>(),
        isDevelopmentFallback: false,
      };
    }

    const myRole = roles.find((r) => r.name === myAssignment.roleName);
    const permissions = new Set<AdminPermission>(myRole?.permissions ?? []);

    return {
      role: myAssignment.roleName,
      permissions,
      isDevelopmentFallback: false,
    };
  }, [address, isEligible, adminsQuery.data, rolesQuery.data]);

  const isLoading = isEligible && (rolesQuery.isLoading || adminsQuery.isLoading);
  const isError = Boolean(rolesQuery.error || adminsQuery.error);
  const error = (rolesQuery.error as Error) || (adminsQuery.error as Error) || null;

  const can = (permission: AdminPermission): boolean => {
    return resolved.permissions.has(permission);
  };

  return {
    role: resolved.role,
    permissions: resolved.permissions,
    can,
    isLoading,
    isError,
    error,
    refetch,
    isDevelopmentFallback: resolved.isDevelopmentFallback,
    isEligibleAdminIdentity: isEligible,
  };
}
