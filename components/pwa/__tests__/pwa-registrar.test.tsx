import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { PwaRegistrar } from "../pwa-registrar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/markets",
}));

describe("PwaRegistrar", () => {
  let messageListeners: ((event: MessageEvent) => void)[] = [];
  let registrationCallbacks: { updatefound?: () => void } = {};
  let installingWorker: { state: string; addEventListener: (event: string, cb: () => void) => void } | null = null;
  let workerStateListeners: (() => void)[] = [];

  beforeEach(() => {
    messageListeners = [];
    registrationCallbacks = {};
    workerStateListeners = [];
    installingWorker = null;

    Object.defineProperty(global, "navigator", {
      value: {
        serviceWorker: {
          controller: {},
          addEventListener: vi.fn((event: string, cb: (e: MessageEvent) => void) => {
            if (event === "message") messageListeners.push(cb);
          }),
          removeEventListener: vi.fn(),
          register: vi.fn().mockResolvedValue({
            waiting: null,
            get installing() {
              return installingWorker;
            },
            addEventListener: vi.fn((event: string, cb: () => void) => {
              if (event === "updatefound") registrationCallbacks.updatefound = cb;
            }),
          }),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  it("renders children normally when no update is waiting", () => {
    render(
      <PwaRegistrar>
        <div data-testid="child">App Content</div>
      </PwaRegistrar>
    );

    expect(screen.getByTestId("child")).toBeDefined();
    expect(screen.queryByText(/A new version of OracleDesk is available/i)).toBeNull();
  });

  it("refuses to show reload banner when an installing worker goes redundant", async () => {
    installingWorker = {
      state: "installing",
      addEventListener: vi.fn((event: string, cb: () => void) => {
        if (event === "statechange") workerStateListeners.push(cb);
      }),
    };

    render(
      <PwaRegistrar>
        <div>App Content</div>
      </PwaRegistrar>
    );

    // Trigger updatefound
    act(() => {
      registrationCallbacks.updatefound?.();
    });

    // Worker fails install and becomes redundant
    act(() => {
      if (installingWorker) installingWorker.state = "redundant";
      for (const cb of workerStateListeners) cb();
    });

    // Must NOT show update available / reload banner
    expect(screen.queryByText(/A new version of OracleDesk is available/i)).toBeNull();

    // Must show integrity failure alert
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/Update Integrity Failure/i)).toBeDefined();
  });

  it("handles PRECACHE_VERIFICATION_FAILED message from service worker", async () => {
    render(
      <PwaRegistrar>
        <div>App Content</div>
      </PwaRegistrar>
    );

    act(() => {
      for (const listener of messageListeners) {
        listener({
          data: {
            type: "PRECACHE_VERIFICATION_FAILED",
            buildId: "build-123",
            failures: [
              {
                url: "/_next/static/chunks/main.js",
                expected: "hash1",
                actual: "hash2",
                reason: "digest mismatch",
              },
            ],
          },
        } as MessageEvent);
      }
    });

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/failed integrity verification/i)).toBeDefined();
    expect(screen.getByText(/1 asset mismatch/i)).toBeDefined();
  });
});
