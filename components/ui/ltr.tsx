import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface LtrProps {
  as?: "bdi" | "span";
  className?: string;
  children: ReactNode;
}

/**
 * Isolates Stellar addresses, contract IDs, transaction hashes, IPFS CIDs,
 * on-chain IDs (#12), and amount+unit pairs (e.g. "1,234.50 USDC") in an
 * explicit LTR bidi-isolated container so RTL layout never reorders them.
 */
export function Ltr({ as = "bdi", className, children }: LtrProps) {
  if (as === "span") {
    return (
      <span
        dir="ltr"
        style={{ unicodeBidi: "isolate" }}
        className={cn("font-data-mono", className)}
      >
        {children}
      </span>
    );
  }
  return (
    <bdi dir="ltr" className={cn("font-data-mono", className)}>
      {children}
    </bdi>
  );
}
