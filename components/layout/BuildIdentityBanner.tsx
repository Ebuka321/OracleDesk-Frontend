import { BUILD_IDENTITY, IDENTITIES } from "@/lib/stellar/config";
import { SigningIdentities } from "@/components/tx-review";

/**
 * Persistent, non-dismissable banner (issue #122) shown on every page when
 * this build's contract addresses differ from the pinned deployment manifest
 * (lib/stellar/generated/contract-manifest.ts) — a forked, tampered or
 * misconfigured build must be impossible to miss. Renders nothing on a
 * canonical build.
 *
 * Colour is not the only signal: the banner has explicit text and a list of
 * every identity with its source.
 */
export function BuildIdentityBanner() {
  if (BUILD_IDENTITY.canonical) return null;

  const overriddenLabels = BUILD_IDENTITY.overridden.map((key) => IDENTITIES[key].label);

  return (
    <div
      role="alert"
      data-testid="build-identity-banner"
      className="border-b border-error/40 bg-error-container/20 px-gutter py-3 text-error"
    >
      <div className="max-w-container-max-width mx-auto space-y-2">
        <p className="font-body-md font-medium">
          This build uses contract addresses that differ from the official OracleDesk deployment. Check every
          address carefully before you sign anything.
        </p>
        <p className="text-sm">
          {overriddenLabels.length > 0 ? `Affected: ${overriddenLabels.join(", ")}. ` : ""}
          Manifest commit: {BUILD_IDENTITY.manifestCommit.slice(0, 7)}.
        </p>
        <details className="text-sm text-on-surface">
          <summary className="cursor-pointer text-error underline">
            Show every contract address in this build
          </summary>
          <div className="mt-2">
            <SigningIdentities keys={["marketCore", "treasury", "resolver", "reasoningRegistry", "usdc", "paymentsRecipient"]} />
          </div>
        </details>
      </div>
    </div>
  );
}
