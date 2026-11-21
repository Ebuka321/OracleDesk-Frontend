"use client";

import { useSyncExternalStore } from "react";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) {
    return () => {};
  }
  const mediaQuery = window.matchMedia("(forced-colors: active)");
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", callback);
    return () => mediaQuery.removeEventListener("change", callback);
  } else if ("addListener" in mediaQuery) {
    // Legacy browser fallback
    (mediaQuery as any).addListener(callback);
    return () => (mediaQuery as any).removeListener(callback);
  }
  return () => {};
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) {
    return false;
  }
  return window.matchMedia("(forced-colors: active)").matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * SSR-safe hook returning true when `@media (forced-colors: active)` matches.
 */
export function useForcedColors(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
