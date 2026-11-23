"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { reportError } from "@/lib/observability/report";

/**
 * Shared recovery UI for app/error.tsx and app/global-error.tsx (issue
 * #123): reports the error exactly once, shows a reference id the user can
 * quote to support, and offers a safe retry. Works without React context
 * (global-error replaces the root layout, so providers are unavailable).
 */
export function ErrorRecovery({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reported = useRef(false);
  const [reference, setReference] = useState<string | null>(null);

  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    const id = reportError(error, { route: typeof window === "undefined" ? undefined : window.location.pathname });
    setReference(id);
  }, [error]);

  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center bg-surface px-gutter py-16 text-center">
      <h1 className="mb-3 font-headline-md text-headline-md text-on-surface">Something went wrong on this page</h1>
      <p className="mb-6 max-w-md text-body-md text-on-surface-variant">
        The page couldn&apos;t finish loading. You can try again, or go back to the markets — nothing you were doing
        has been changed.
      </p>
      {reference && (
        <p className="mb-6 font-data-mono text-sm text-on-surface-variant">
          Reference: <span className="text-on-surface">{reference}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-lg bg-primary px-5 py-2.5 font-label-caps text-sm text-on-primary"
        >
          Try again
        </button>
        <Link href="/markets" className="rounded-lg border border-outline-variant px-5 py-2.5 font-label-caps text-sm text-on-surface">
          Go to markets
        </Link>
      </div>
    </div>
  );
}
