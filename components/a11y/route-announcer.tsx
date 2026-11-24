"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LiveRegion } from "@/components/ui/live-region";
import { subscribeRouteStatus } from "@/lib/a11y/route-status";

export function RouteFocusManager() {
  const pathname = usePathname();
  const router = useRouter();
  const previousPathname = useRef(pathname);
  const [status, setStatus] = useState("");

  useEffect(() => subscribeRouteStatus(setStatus), []);

  useEffect(() => {
    if (!pathname || previousPathname.current === pathname) return;
    previousPathname.current = pathname;

    let observer: MutationObserver | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const focusAfterNavigation = () => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const active = document.activeElement;
      const main = document.querySelector<HTMLElement>("#main-content");
      if (active instanceof HTMLElement && main?.contains(active) && active !== document.body) return;

      const heading = document.querySelector<HTMLElement>("[data-route-heading]");
      (heading ?? main)?.focus({ preventScroll: true });
    };

    const heading = document.querySelector<HTMLElement>("[data-route-heading]");
    if (heading) {
      requestAnimationFrame(focusAfterNavigation);
    } else if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(() => {
        if (document.querySelector("[data-route-heading]")) {
          observer?.disconnect();
          requestAnimationFrame(focusAfterNavigation);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      timeout = setTimeout(() => {
        observer?.disconnect();
        focusAfterNavigation();
      }, 1_500);
    }

    return () => {
      observer?.disconnect();
      if (timeout) clearTimeout(timeout);
    };
  }, [pathname]);

  useEffect(() => {
    const historyId = cryptoRandomId();
    history.replaceState({ ...history.state, odHistoryId: historyId }, "");
    const onPopState = () => {
      requestAnimationFrame(() => {
        const heading = document.querySelector<HTMLElement>("[data-route-heading]");
        (heading ?? document.querySelector<HTMLElement>("#main-content"))?.focus({ preventScroll: true });
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [router]);

  return <LiveRegion message={status} politeness="polite" />;
}

function cryptoRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random()}`;
}
