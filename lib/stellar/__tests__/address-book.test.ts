// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDRESS_BOOK_CAP,
  addToBook,
  addressBookKey,
  loadBook,
  removeFromBook,
  subscribeBook,
} from "../address-book";

describe("address-book", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("isolates entries per wallet and network", () => {
    addToBook("G_WALLET_A", { address: "G_1", label: "One" }, "testnet");
    addToBook("G_WALLET_B", { address: "G_2", label: "Two" }, "testnet");
    addToBook("G_WALLET_A", { address: "G_3", label: "Three" }, "mainnet");

    expect(loadBook("G_WALLET_A", "testnet").map((e) => e.address)).toEqual(["G_1"]);
    expect(loadBook("G_WALLET_B", "testnet").map((e) => e.address)).toEqual(["G_2"]);
    expect(loadBook("G_WALLET_A", "mainnet").map((e) => e.address)).toEqual(["G_3"]);
  });

  it("caps stored entries at 500", () => {
    for (let i = 0; i < ADDRESS_BOOK_CAP + 15; i++) {
      addToBook("G_WALLET_A", { address: `G_${i}`, label: `Label ${i}`, addedAt: i }, "testnet");
    }
    const loaded = loadBook("G_WALLET_A", "testnet");
    expect(loaded).toHaveLength(ADDRESS_BOOK_CAP);
    expect(loaded[0]?.address).toBe("G_15");
  }, 15_000);

  it("recovers gracefully from corrupt JSON", () => {
    window.localStorage.setItem(addressBookKey("G_WALLET_A", "testnet"), "{not valid json");
    expect(loadBook("G_WALLET_A", "testnet")).toEqual([]);
  });

  it("removes entries and notifies on cross-tab storage events", () => {
    addToBook("G_WALLET_A", { address: "G_1", label: "One" }, "testnet");
    expect(removeFromBook("G_WALLET_A", "G_1", "testnet")).toEqual([]);

    const onChange = vi.fn();
    const unsub = subscribeBook("G_WALLET_A", onChange, "testnet");
    window.dispatchEvent(
      new StorageEvent("storage", { key: addressBookKey("G_WALLET_A", "testnet") }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    unsub();
  });
});
