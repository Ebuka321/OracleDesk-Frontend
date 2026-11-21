/**
 * Controlled asynchronous message buses for multi-tab tests:
 *  - `FakeBroadcastBus`: implements `BroadcastChannel` across tabs with
 *    deterministic queueing, delaying, reordering, dropping, and targeted delivery.
 *  - `FakeStorageBus`: implements shared `localStorage` and cross-tab `storage`
 *    events with the same adversarial delivery controls.
 *
 * Per browser spec, neither `BroadcastChannel` nor `storage` events are ever
 * delivered back to the originating tab.
 */

export interface QueuedBroadcast {
  id: number;
  channelName: string;
  senderTabId: string;
  data: unknown;
  delivered: boolean;
  dropped: boolean;
}

export interface QueuedStorageEvent {
  id: number;
  senderTabId: string;
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  delivered: boolean;
  dropped: boolean;
}

export class FakeBroadcastChannel {
  readonly name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  private readonly listeners = new Set<(event: MessageEvent) => void>();
  private closed = false;

  constructor(
    name: string,
    private readonly tabId: string,
    private readonly bus: FakeBroadcastBus,
  ) {
    this.name = name;
    this.bus.register(this);
  }

  get ownerTabId(): string {
    return this.tabId;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.bus.enqueue(this.name, this.tabId, structuredClone(message));
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "message") return;
    if (typeof listener === "function") {
      this.listeners.add(listener as (event: MessageEvent) => void);
    } else if (listener && typeof listener.handleEvent === "function") {
      this.listeners.add((ev) => listener.handleEvent(ev));
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type !== "message") return;
    if (typeof listener === "function") {
      this.listeners.delete(listener as (event: MessageEvent) => void);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.onmessage = null;
    this.bus.unregister(this);
  }

  /** Internal: delivers a message to this channel's handlers. */
  _dispatch(data: unknown): void {
    if (this.closed) return;
    const event = { data, type: "message", target: this } as unknown as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}

export class FakeBroadcastBus {
  private readonly channels = new Set<FakeBroadcastChannel>();
  private queue: QueuedBroadcast[] = [];
  private nextId = 1;
  autoDeliver = false;

  register(channel: FakeBroadcastChannel): void {
    this.channels.add(channel);
  }

  unregister(channel: FakeBroadcastChannel): void {
    this.channels.delete(channel);
  }

  closeTab(tabId: string): void {
    for (const ch of [...this.channels]) {
      if (ch.ownerTabId === tabId) ch.close();
    }
  }

  createConstructorForTab(tabId: string): typeof BroadcastChannel {
    const bus = this;
    return class TabBroadcastChannel extends FakeBroadcastChannel {
      constructor(name: string) {
        super(name, tabId, bus);
      }
    } as unknown as typeof BroadcastChannel;
  }

  enqueue(channelName: string, senderTabId: string, data: unknown): QueuedBroadcast {
    const entry: QueuedBroadcast = {
      id: this.nextId++,
      channelName,
      senderTabId,
      data,
      delivered: false,
      dropped: false,
    };
    this.queue.push(entry);
    if (this.autoDeliver) {
      queueMicrotask(() => {
        if (!entry.delivered && !entry.dropped) {
          this.deliverMessage(entry);
        }
      });
    }
    return entry;
  }

  get pending(): readonly QueuedBroadcast[] {
    return this.queue.filter((m) => !m.delivered && !m.dropped);
  }

  deliverAll(targetTabIds?: readonly string[]): number {
    let count = 0;
    while (true) {
      const next = this.queue.find((m) => !m.delivered && !m.dropped);
      if (!next) break;
      this.deliverMessage(next, targetTabIds);
      count++;
    }
    return count;
  }

  deliverNext(targetTabIds?: readonly string[]): QueuedBroadcast | null {
    const next = this.queue.find((m) => !m.delivered && !m.dropped);
    if (!next) return null;
    this.deliverMessage(next, targetTabIds);
    return next;
  }

  deliverOnlyTo(tabIds: readonly string[]): number {
    return this.deliverAll(tabIds);
  }

  delay(ms: number, targetTabIds?: readonly string[]): void {
    const snapshot = [...this.pending];
    for (const msg of snapshot) {
      msg.delivered = true; // claim so deliverAll won't double-deliver
      setTimeout(() => {
        if (msg.dropped) return;
        this.dispatchToChannels(msg, targetTabIds);
      }, ms);
    }
  }

  reorder(comparator: (a: QueuedBroadcast, b: QueuedBroadcast) => number): void {
    const pending = this.queue.filter((m) => !m.delivered && !m.dropped);
    const done = this.queue.filter((m) => m.delivered || m.dropped);
    pending.sort(comparator);
    this.queue = [...done, ...pending];
  }

  drop(predicate: (msg: QueuedBroadcast) => boolean = () => true): number {
    let count = 0;
    for (const msg of this.queue) {
      if (!msg.delivered && !msg.dropped && predicate(msg)) {
        msg.dropped = true;
        count++;
      }
    }
    return count;
  }

  private deliverMessage(msg: QueuedBroadcast, targetTabIds?: readonly string[]): void {
    msg.delivered = true;
    this.dispatchToChannels(msg, targetTabIds);
  }

  private dispatchToChannels(msg: QueuedBroadcast, targetTabIds?: readonly string[]): void {
    for (const ch of [...this.channels]) {
      if (ch.name !== msg.channelName) continue;
      if (ch.ownerTabId === msg.senderTabId) continue;
      if (targetTabIds && !targetTabIds.includes(ch.ownerTabId)) continue;
      ch._dispatch(structuredClone(msg.data));
    }
  }
}

export class FakeStorageBus {
  private readonly store = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: StorageEvent) => void>>();
  private queue: QueuedStorageEvent[] = [];
  private nextId = 1;
  autoDeliver = false;

  addListener(tabId: string, fn: (event: StorageEvent) => void): void {
    let set = this.listeners.get(tabId);
    if (!set) {
      set = new Set();
      this.listeners.set(tabId, set);
    }
    set.add(fn);
  }

  removeListener(tabId: string, fn: (event: StorageEvent) => void): void {
    this.listeners.get(tabId)?.delete(fn);
  }

  closeTab(tabId: string): void {
    this.listeners.delete(tabId);
  }

  createStorageForTab(tabId: string): Storage {
    const bus = this;
    return {
      get length() {
        return bus.store.size;
      },
      key(index: number): string | null {
        return Array.from(bus.store.keys())[index] ?? null;
      },
      getItem(key: string): string | null {
        return bus.store.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        const str = String(value);
        const oldValue = bus.store.get(key) ?? null;
        bus.store.set(key, str);
        if (oldValue !== str) {
          bus.enqueue(tabId, key, oldValue, str);
        }
      },
      removeItem(key: string): void {
        if (!bus.store.has(key)) return;
        const oldValue = bus.store.get(key) ?? null;
        bus.store.delete(key);
        bus.enqueue(tabId, key, oldValue, null);
      },
      clear(): void {
        if (bus.store.size === 0) return;
        bus.store.clear();
        bus.enqueue(tabId, null, null, null);
      },
    };
  }

  get pending(): readonly QueuedStorageEvent[] {
    return this.queue.filter((e) => !e.delivered && !e.dropped);
  }

  deliverAll(targetTabIds?: readonly string[]): number {
    let count = 0;
    while (true) {
      const next = this.queue.find((e) => !e.delivered && !e.dropped);
      if (!next) break;
      this.deliverEvent(next, targetTabIds);
      count++;
    }
    return count;
  }

  deliverNext(targetTabIds?: readonly string[]): QueuedStorageEvent | null {
    const next = this.queue.find((e) => !e.delivered && !e.dropped);
    if (!next) return null;
    this.deliverEvent(next, targetTabIds);
    return next;
  }

  deliverOnlyTo(tabIds: readonly string[]): number {
    return this.deliverAll(tabIds);
  }

  delay(ms: number, targetTabIds?: readonly string[]): void {
    const snapshot = [...this.pending];
    for (const ev of snapshot) {
      ev.delivered = true;
      setTimeout(() => {
        if (ev.dropped) return;
        this.dispatchToTabs(ev, targetTabIds);
      }, ms);
    }
  }

  reorder(comparator: (a: QueuedStorageEvent, b: QueuedStorageEvent) => number): void {
    const pending = this.queue.filter((e) => !e.delivered && !e.dropped);
    const done = this.queue.filter((e) => e.delivered || e.dropped);
    pending.sort(comparator);
    this.queue = [...done, ...pending];
  }

  drop(predicate: (ev: QueuedStorageEvent) => boolean = () => true): number {
    let count = 0;
    for (const ev of this.queue) {
      if (!ev.delivered && !ev.dropped && predicate(ev)) {
        ev.dropped = true;
        count++;
      }
    }
    return count;
  }

  private enqueue(senderTabId: string, key: string | null, oldValue: string | null, newValue: string | null): void {
    const entry: QueuedStorageEvent = {
      id: this.nextId++,
      senderTabId,
      key,
      oldValue,
      newValue,
      delivered: false,
      dropped: false,
    };
    this.queue.push(entry);
    if (this.autoDeliver) {
      queueMicrotask(() => {
        if (!entry.delivered && !entry.dropped) {
          this.deliverEvent(entry);
        }
      });
    }
  }

  private deliverEvent(ev: QueuedStorageEvent, targetTabIds?: readonly string[]): void {
    ev.delivered = true;
    this.dispatchToTabs(ev, targetTabIds);
  }

  private dispatchToTabs(ev: QueuedStorageEvent, targetTabIds?: readonly string[]): void {
    for (const [tabId, set] of this.listeners.entries()) {
      if (tabId === ev.senderTabId) continue;
      if (targetTabIds && !targetTabIds.includes(tabId)) continue;
      const storageEvent = {
        type: "storage",
        key: ev.key,
        oldValue: ev.oldValue,
        newValue: ev.newValue,
        storageArea: null,
        url: "http://localhost:3000/",
      } as unknown as StorageEvent;
      for (const fn of [...set]) {
        fn(storageEvent);
      }
    }
  }
}

export function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
  };
}
