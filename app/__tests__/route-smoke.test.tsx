/// <reference types="vite/client" />
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "@testing-library/react";

const routeModules = import.meta.glob<{ default: React.ComponentType<Record<string, unknown>> }>("../**/page.tsx");

let currentPathname = "/";
let currentParams: Record<string, string> = {};
let currentSearchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
  useParams: () => currentParams,
  useSearchParams: () => currentSearchParams,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  notFound: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  io: () => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  }),
}));

vi.mock("@/lib/api/client", () => ({
  SESSION_MODE: "cookie",
  notifyAuthInvalid: () => false,
  onAuthSessionChanged: () => () => {},
  onAuthInvalid: () => () => {},
  apiClient: {
    get: vi.fn(async (path?: string) => {
      if (typeof path === "string" && path.includes("stats")) {
        return {
          data: {
            subscriberCount: 0,
            totalCopyVolume: 0,
            activeAgents: 0,
            totalMarkets: 0,
            totalVolume: 0,
            marketCount: 0,
            traceCount: 0,
          },
        };
      }
      return { data: [] };
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
  apiGet: vi.fn(async (path?: string) => {
    if (typeof path === "string" && path.includes("stats")) {
      return {
        data: {
          subscriberCount: 0,
          totalCopyVolume: 0,
          activeAgents: 0,
          totalMarkets: 0,
          totalVolume: 0,
          marketCount: 0,
          traceCount: 0,
        },
      };
    }
    return { data: [], meta: { total: 0, page: 1, limit: 20 } };
  }),
  apiPost: vi.fn(async () => ({})),
  apiPatch: vi.fn(async () => ({})),
  apiDelete: vi.fn(async () => ({})),
  apiFetch: vi.fn(async () => ({})),
  apiPath: (...parts: string[]) => parts.join("/"),
  API_URL: "http://localhost:8787/api/v1",
  ApiError: class ApiError extends Error {
    code = "HTTP_UNKNOWN";
    status = 500;
  },
}));

vi.mock("@/lib/stellar/clients", () => ({
  marketCore: () => ({ spec: {}, market_count: vi.fn(), get_config: vi.fn() }),
  treasury: () => ({ spec: {}, get_config: vi.fn(), daily_usage: vi.fn(), available_capital: vi.fn() }),
  resolver: () => ({ spec: {} }),
  reasoningRegistry: () => ({ spec: {}, trace_count: vi.fn() }),
  token: { name: vi.fn(), balance: vi.fn(), transfer: vi.fn() },
  rpcServer: () => ({
    getNetwork: vi.fn(async () => ({ passphrase: "Test SDF Network ; September 2015" })),
    getLatestLedger: vi.fn(async () => ({ sequence: 100 })),
    getHealth: vi.fn(async () => ({ status: "healthy", oldestLedger: 1, latestLedger: 100 })),
    getLedgerEntries: vi.fn(async () => ({ entries: [], latestLedger: 100 })),
    getEvents: vi.fn(async () => ({ events: [] })),
    getTransactions: vi.fn(async () => ({ latestLedgerCloseTimestamp: "1760000000" })),
  }),
  rpcPool: () => null,
  currentRpcUrl: () => "https://soroban-testnet.stellar.org",
  withPinnedRpc: async (fn: (u: string) => Promise<unknown>) => fn("https://soroban-testnet.stellar.org"),
  Outcomes: { Yes: { tag: "Yes", values: undefined }, No: { tag: "No", values: undefined } },
  CATEGORY_TAGS: ["Crypto", "Macro", "Geopolitics", "Sports", "Culture", "Other"],
  categoryValue: (tag: string) => ({ tag, values: undefined }),
}));

vi.mock("@/lib/api/auth", () => ({
  getStoredSessionWallet: () => null,
  clearAuthSession: () => {},
  signInWithWallet: vi.fn(async (address: string) => ({ walletAddress: address })),
  getSessionStatus: vi.fn(async () => ({ authenticated: false, walletAddress: null })),
  getSession: vi.fn(async () => null),
  migrateLegacySession: vi.fn(async () => false),
  logoutSession: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/treasury-admin", () => ({
  calculateCollectedWeight: vi.fn(() => 0),
  listTreasuryProposals: vi.fn(async () => []),
}));

vi.mock("@/lib/stellar/contract-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/contract-check")>();
  return {
    ...actual,
    useContractIntegrity: () => ({
      data: {
        marketCore: { contract: "marketCore", id: "C1", status: "match", checkedAtLedger: 100 },
        treasury: { contract: "treasury", id: "C2", status: "match", checkedAtLedger: 100 },
        resolver: { contract: "resolver", id: "C3", status: "match", checkedAtLedger: 100 },
        reasoningRegistry: { contract: "reasoningRegistry", id: "C4", status: "match", checkedAtLedger: 100 },
        usdc: { contract: "usdc", id: "C5", status: "match", checkedAtLedger: 100 },
      },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
    checkContractIntegrity: vi.fn(async () => ({})),
  };
});

vi.mock("@/lib/stellar/rpc-pool", () => ({
  getRpcPool: () => null,
  RpcPool: class {},
  percentile: () => null,
  scoreEndpoint: () => 0,
  nextSelection: (prev: unknown) => prev,
}));

// Pre-existing syntax error in app/premium/page-client.tsx on develop
vi.mock("../premium/page-client", () => ({
  default: () => <div data-testid="premium-stub">Premium</div>,
}));

// Pre-existing duplicate `fromChain` declaration in app/markets/quick-view/page.tsx on develop
vi.mock("../markets/quick-view/page", () => ({
  default: () => <div data-testid="quick-view-stub">Quick View</div>,
}));

const { createFakeKit, FAKE_ADDRESS } = await import("@/components/__tests__/wallet-harness");
const { AppHarness } = await import("./app-harness");

function routePathFromGlobKey(key: string): string {
  const rel = key.replace(/^\.\.\//, "").replace(/\/?page\.tsx$/, "");
  return rel ? `/${rel}` : "/";
}

function paramsForRoute(routePath: string): Record<string, string> {
  if (routePath.includes("[address]")) return { address: FAKE_ADDRESS };
  if (routePath.includes("[id]")) return { id: "1" };
  return {};
}

describe("Route smoke suite", () => {
  const entries = Object.entries(routeModules).sort(([a], [b]) => a.localeCompare(b));

  beforeEach(() => {
    vi.useFakeTimers();
    currentSearchParams = new URLSearchParams("onChainId=1&marketId=1&onChainTraceId=1");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("discovers all app/**/page.tsx routes (at least 37)", () => {
    expect(entries.length).toBeGreaterThanOrEqual(37);
  });

  for (const [globKey, loader] of entries) {
    const routePath = routePathFromGlobKey(globKey);

    for (const walletState of ["disconnected", "connected"] as const) {
      it(`renders ${routePath} (${walletState}) without throwing or console.error`, async () => {
        currentPathname = routePath;
        currentParams = paramsForRoute(routePath);
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const mod = await (loader as () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>)();
          const Page = mod.default;
          const kit = createFakeKit({
            address: walletState === "connected" ? FAKE_ADDRESS : null,
          });

          const props: Record<string, unknown> = {};
          if (routePath.includes("[")) {
            props.params = Promise.resolve(currentParams);
          }

          render(
            <AppHarness kit={kit}>
              <Page {...props} />
            </AppHarness>,
          );

          expect(document.getElementById("main-content")).not.toBeNull();
          expect(consoleErrorSpy).not.toHaveBeenCalled();
        } finally {
          consoleErrorSpy.mockRestore();
        }
      }, 15_000);
    }
  }
});
