import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy | OracleDesk",
  description: "What OracleDesk collects, what it hashes, and how to opt out.",
};

/**
 * Privacy summary (issues #123 and #125). The full field-by-field inventory
 * lives in docs/privacy.md in the repository; this page mirrors it for
 * users. Static and server-rendered on purpose: loading it must not depend
 * on any script or network call.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-grow px-gutter pb-20 pt-10">
      <h1 className="mb-4 font-headline-md text-headline-md text-on-surface">Privacy</h1>
      <p className="mb-6 text-body-md text-on-surface-variant">
        OracleDesk works without any analytics or error reporting. Both are off unless the deployment configures
        them, and neither sends anything before you explicitly agree.
      </p>

      <section className="mb-8 space-y-3">
        <h2 className="font-headline-sm text-headline-sm">Error reports (optional)</h2>
        <p className="text-body-md text-on-surface-variant">
          If enabled, an error report contains: the error message and stack, the page path (never the query
          string), which feature failed (buy, sell, premium, connect, …), the contract error name when there is
          one, the HTTP status for backend errors, your wallet module (e.g. Freighter), breadcrumbs of route
          changes and trade attempts, and a release identifier.
        </p>
        <p className="text-body-md text-on-surface-variant">
          It never contains: your wallet address (replaced by a per-install salted hash), JWTs, secret seeds,
          signatures, transaction XDR, or Authorization headers — every event is redacted twice and dropped
          entirely if any token pattern survives. Amounts and transaction hashes are not part of reports.
        </p>
        <p className="text-body-md text-on-surface-variant">
          Consent defaults to off, is stored only in your browser, can be changed any time in{" "}
          <Link href="/settings" className="text-primary underline">
            settings
          </Link>
          , and Do Not Track / Global Privacy Control are always treated as &quot;off&quot;.
        </p>
      </section>

      <section className="mb-8 space-y-3">
        <h2 className="font-headline-sm text-headline-sm">Usage analytics (optional)</h2>
        <p className="text-body-md text-on-surface-variant">
          If enabled, anonymous funnel events record that something happened — a wallet was connected, a quote
          requested, a trade completed — with amounts grouped into buckets (e.g. 10–100 USDC), never exact
          values, and never addresses, transaction hashes or market ids. You agree in the banner shown when
          analytics is configured; until then no script loads and no request is made.
        </p>
      </section>

      <section className="mb-8 space-y-3">
        <h2 className="font-headline-sm text-headline-sm">Contract addresses shown before signing</h2>
        <p className="text-body-md text-on-surface-variant">
          OracleDesk always shows the full contract addresses it will interact with, grouped in four-character
          chunks, plus a three-word fingerprint derived from the address, so you can compare them against an
          independent explorer before approving a transaction. Builds that override the official deployment show
          a warning banner on every page.
        </p>
      </section>

      <p className="text-sm text-on-surface-variant">
        The complete field inventory, retention notes and a changelog live in <code>docs/privacy.md</code> in the
        repository.
      </p>
    </main>
  );
}
