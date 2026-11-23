import type { Route } from "next";
import { routes } from "@/lib/routes";

export interface NavItem {
  label: string;
  href: Route;
  children?: { label: string; href: Route }[];
  /** Permission required to view this item in navigation (RBAC) */
  permission?: "admin.read";
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Markets",
    href: routes.markets(),
    children: [
      { label: "Live Terminal", href: routes.marketsTerminal() },
      { label: "Active Market Detail", href: routes.market() },
      { label: "FPMM Explainer", href: routes.learnFpmm() },
    ],
  },
  {
    label: "Reasoning",
    href: routes.reasoning(),
  },
  {
    label: "Portfolio",
    href: routes.portfolio(),
    children: [
      { label: "Active Positions", href: routes.portfolio() },
      { label: "Analytics", href: routes.portfolioAnalytics() },
      { label: "Portfolio & Assets", href: routes.portfolioWallets() },
    ],
  },
  {
    label: "Stats",
    href: routes.stats(),
  },
  {
    label: "Admin",
    href: routes.admin(),
    permission: "admin.read",
  },
] as const;

/**
 * Returns whether an item or one of its children matches the current pathname.
 * Retains section parent active highlighting.
 */
export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href === pathname) return true;
  if (item.children) {
    return item.children.some((child) => child.href === pathname);
  }
  return false;
}

/**
 * Returns the single exact href that should carry aria-current="page".
 * Exact child match wins over parent section match.
 */
export function activeHref(pathname: string): string | null {
  // Exact match on child items wins first
  for (const item of NAV_ITEMS) {
    if (item.children) {
      for (const child of item.children) {
        if (child.href === pathname) {
          return child.href;
        }
      }
    }
  }
  // Then exact match on top-level items
  for (const item of NAV_ITEMS) {
    if (item.href === pathname) {
      return item.href;
    }
  }
  return null;
}
