"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export interface StaticRedirectProps {
  to: string;
  title: string;
}

/**
 * Static redirect page with HTML meta refresh and client-side router fallback.
 * Works seamlessly under static export (output: 'export') without server redirects.
 */
export function StaticRedirect({ to, title }: StaticRedirectProps) {
  const router = useRouter();

  useEffect(() => {
    router.replace(to);
  }, [router, to]);

  return (
    <div className="min-h-[50vh] flex flex-col items-center justify-center p-8 text-center space-y-4">
      <meta httpEquiv="refresh" content={`0;url=${to}`} />
      <h1 className="font-headline-md text-headline-md font-bold">Redirecting…</h1>
      <p className="text-on-surface-variant text-sm">
        {title} has moved. Redirecting you to <a href={to} className="underline text-primary">{to}</a>.
      </p>
    </div>
  );
}
