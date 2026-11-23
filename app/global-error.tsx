"use client";

import { ErrorRecovery } from "@/components/observability/ErrorRecovery";

/**
 * Root error boundary (issue #123). Replaces the root layout when a render
 * error escapes it, so it renders its own <html>/<body> and must not depend
 * on any React context (WalletProvider and friends are unavailable here).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>
        <ErrorRecovery error={error} reset={reset} />
      </body>
    </html>
  );
}
