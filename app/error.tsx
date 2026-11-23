"use client";

import { ErrorRecovery } from "@/components/observability/ErrorRecovery";

/**
 * Route-level error boundary (issue #123). Reports the error once (with
 * redaction, behind consent) and renders a recovery UI with a reference id.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorRecovery error={error} reset={reset} />;
}
