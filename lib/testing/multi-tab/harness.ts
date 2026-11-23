/**
 * Multi-tab coordination test harness.
 *
 * Simulates N browser tabs in a single Vitest process:
 *  - Each tab has isolated `sessionStorage`, `document` visibility state,
 *    window event listeners, and isolated module instances (via `vi.resetModules`).
 *  - All tabs share one `localStorage`, one `fake-indexeddb` `IDBFactory`,
 *    one `FakeLockManager` (removable per tab to test fallback paths),
 *    one `FakeBroadcastBus`, and one `FakeStorageBus`.
 *  - Integrates with Vitest fake timers so every race is deterministic with no real sleeping.
 */

import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";
import { FakeLockManager } from "./web-locks";
import { FakeBroadcastBus, FakeStorageBus, createMemoryStorage } from "./message-bus";

export interface TabOptions {
  id?: string;
  /** Whether `navigator.locks` is exposed in this tab. Defaults to `true`. */
  webLocks?: boolean;
  /** Initial `document.visibilityState`. Defaults to `"visible"`. */
  visibility?: DocumentVisibilityState;
}

interface TabGlobals {
  window: Window;
  document: Document;
  navigator: Navigator;
  localStorage: Storage;
  sessionStorage: Storage;
  BroadcastChannel: typeof BroadcastChannel;
  indexedDB: IDBFactory;
}

export class SimulatedTab {
  readonly id: string;
  readonly localStorage: Storage;
  readonly sessionStorage: Storage;
  readonly BroadcastChannel: typeof BroadcastChannel;
  readonly indexedDB: IDBFactory;
  private webLocksEnabled: boolean;
  private visibilityState: DocumentVisibilityState;
  private closed = false;
  private readonly docListeners = new Map<string, Set<() => void>>();
  private readonly winListeners = new Map<string, Set<(ev: Event) => void>>();

  constructor(
    id: string,
    private readonly harness: MultiTabHarness,
    opts: TabOptions = {},
  ) {
    this.id = id;
    this.webLocksEnabled = opts.webLocks ?? true;
    this.visibilityState = opts.visibility ?? "visible";
    this.localStorage = harness.storage.createStorageForTab(id);
    this.sessionStorage = createMemoryStorage();
    this.BroadcastChannel = harness.broadcast.createConstructorForTab(id);
    this.indexedDB = harness.indexedDB;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isWebLocksEnabled(): boolean {
    return this.webLocksEnabled;
  }

  setWebLocks(enabled: boolean): void {
    this.webLocksEnabled = enabled;
  }

  setVisibility(state: DocumentVisibilityState): void {
    if (this.closed || this.visibilityState === state) return;
    this.visibilityState = state;
    this.runSync(() => {
      const listeners = this.docListeners.get("visibilitychange");
      if (listeners) {
        for (const fn of [...listeners]) fn();
      }
    });
  }

  /** Simulates closing or crashing the tab: releases Web Locks and closes BroadcastChannels, leaves localStorage/IDB intact. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.harness.locks.releaseTab(this.id);
    this.harness.broadcast.closeTab(this.id);
    this.harness.storage.closeTab(this.id);
    this.docListeners.clear();
    this.winListeners.clear();
  }

  /** Creates a fresh, isolated module instance for this tab via `vi.resetModules()`. */
  async importModule<T>(loader: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      vi.resetModules();
      return loader();
    });
  }

  /** Runs synchronous code with this tab's browser globals installed. */
  runSync<T>(fn: () => T): T {
    const prev = this.installGlobals();
    try {
      return fn();
    } finally {
      this.restoreGlobals(prev);
    }
  }

  /** Runs async code with this tab's browser globals installed. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.installGlobals();
    try {
      return await fn();
    } finally {
      this.restoreGlobals(prev);
    }
  }

  private buildGlobals(): TabGlobals {
    const tab = this;
    const documentStub = {
      get visibilityState() {
        return tab.visibilityState;
      },
      get hidden() {
        return tab.visibilityState === "hidden";
      },
      addEventListener(type: string, listener: () => void) {
        let set = tab.docListeners.get(type);
        if (!set) {
          set = new Set();
          tab.docListeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        tab.docListeners.get(type)?.delete(listener);
      },
    } as unknown as Document;

    const navigatorStub = {
      get locks() {
        return tab.webLocksEnabled ? tab.harness.locks.forTab(tab.id) : undefined;
      },
      storage: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ usage: 0, quota: 100 * 1024 * 1024 }),
      },
    } as unknown as Navigator;

    const windowStub = {
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      navigator: navigatorStub,
      document: documentStub,
      BroadcastChannel: this.BroadcastChannel,
      indexedDB: this.indexedDB,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
      addEventListener(type: string, listener: (ev: Event) => void) {
        if (type === "storage") {
          tab.harness.storage.addListener(tab.id, listener as (ev: StorageEvent) => void);
        }
        let set = tab.winListeners.get(type);
        if (!set) {
          set = new Set();
          tab.winListeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener(type: string, listener: (ev: Event) => void) {
        if (type === "storage") {
          tab.harness.storage.removeListener(tab.id, listener as (ev: StorageEvent) => void);
        }
        tab.winListeners.get(type)?.delete(listener);
      },
    } as unknown as Window;

    return {
      window: windowStub,
      document: documentStub,
      navigator: navigatorStub,
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      BroadcastChannel: this.BroadcastChannel,
      indexedDB: this.indexedDB,
    };
  }

  private installGlobals(): Record<string, PropertyDescriptor | undefined> {
    const globals = this.buildGlobals();
    const saved: Record<string, PropertyDescriptor | undefined> = {};
    for (const [key, value] of Object.entries(globals)) {
      saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    return saved;
  }

  private restoreGlobals(saved: Record<string, PropertyDescriptor | undefined>): void {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) {
        Object.defineProperty(globalThis, key, desc);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
}

export interface MultiTabHarnessOptions {
  /** Automatically deliver BroadcastChannel & storage events on microtasks. Defaults to `false` (manual control). */
  autoDeliver?: boolean;
  /** Initial fake clock epoch ms. Defaults to `2026-10-20T10:00:00Z`. */
  startTime?: number;
}

export class MultiTabHarness {
  readonly locks = new FakeLockManager();
  readonly broadcast = new FakeBroadcastBus();
  readonly storage = new FakeStorageBus();
  readonly indexedDB = new IDBFactory();
  readonly tabs: SimulatedTab[] = [];
  private tabCounter = 0;

  constructor(opts: MultiTabHarnessOptions = {}) {
    this.broadcast.autoDeliver = opts.autoDeliver ?? false;
    this.storage.autoDeliver = opts.autoDeliver ?? false;
    vi.useFakeTimers();
    vi.setSystemTime(opts.startTime ?? Date.parse("2026-10-20T10:00:00Z"));
  }

  createTab(opts: TabOptions = {}): SimulatedTab {
    const id = opts.id ?? `tab-${++this.tabCounter}`;
    const tab = new SimulatedTab(id, this, opts);
    this.tabs.push(tab);
    return tab;
  }

  /** Delivers all queued BroadcastChannel messages and storage events across tabs. */
  deliverAll(): void {
    this.storage.deliverAll();
    this.broadcast.deliverAll();
  }

  /** Advances the fake clock and runs due timers without real sleeping. */
  async advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  now(): number {
    return Date.now();
  }

  /** Cleans up all tabs and restores real timers. */
  dispose(): void {
    for (const tab of this.tabs) tab.close();
    this.tabs.length = 0;
    vi.useRealTimers();
  }
}
