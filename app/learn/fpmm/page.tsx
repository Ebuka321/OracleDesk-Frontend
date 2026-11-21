import { Suspense } from "react";
import FpmmExplainerClient from "./page-client";

export const dynamic = "error";

export default function FpmmExplainerPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-5xl mx-auto px-4 py-12 text-center text-on-surface-variant font-mono">
          Loading FPMM explainer…
        </div>
      }
    >
      <FpmmExplainerClient />
    </Suspense>
  );
}
