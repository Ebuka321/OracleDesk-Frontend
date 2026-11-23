"use client";

import { useMemo, useState } from "react";
import { sha256HexOf } from "@/lib/stellar/sha256";
import { shortAddress } from "@/lib/stellar/units";
import { Ltr } from "@/components/ui/ltr";
import { cn } from "@/lib/utils";

const encoder = new TextEncoder();

export function chunkAddress(address: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < address.length; i += 4) {
    chunks.push(address.slice(i, i + 4));
  }
  return chunks;
}

/**
 * Deterministic 5×5 symmetric identicon derived from sha256HexOf(strkeyBytes).
 * Uses theme-compatible colors and a distinct geometric bit pattern so
 * look-alike addresses with matching prefix+suffix produce unrelated patterns.
 */
export function AddressIdenticon({ address, size = 20, className }: { address: string; size?: number; className?: string }) {
  const { cells, fg } = useMemo(() => {
    const hex = sha256HexOf([encoder.encode(address)]);
    const grid: boolean[] = [];
    // 5 rows × 3 columns (cols 0,1,2 mirrored to 4,3) = 15 bits from hex[0..3]
    const bits = parseInt(hex.slice(0, 4), 16);
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        const mc = c > 2 ? 4 - c : c;
        const bitIdx = r * 3 + mc;
        grid.push(((bits >> bitIdx) & 1) === 1);
      }
    }
    const hue = parseInt(hex.slice(4, 7), 16) % 360;
    return { cells: grid, fg: `hsl(${hue} 62% 34%)` };
  }, [address]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      aria-hidden="true"
      className={cn("inline-block shrink-0 rounded-[2px] bg-surface-container-low", className)}
    >
      {cells.map((on, idx) =>
        on ? (
          <rect
            key={idx}
            x={idx % 5}
            y={Math.floor(idx / 5)}
            width={1}
            height={1}
            fill={fg}
          />
        ) : null,
      )}
    </svg>
  );
}

export interface AddressTextProps {
  address: string;
  compact?: boolean;
  showIdenticon?: boolean;
  className?: string;
}

/**
 * Displays a Stellar address in 4-character chunks inside an LTR isolate with
 * a deterministic identicon. In `compact` mode, shows 4+4 with identicon and
 * expands to full chunked form on hover/focus.
 */
export function AddressText({
  address,
  compact = false,
  showIdenticon = true,
  className,
}: AddressTextProps) {
  const [expanded, setExpanded] = useState(false);
  const chunks = useMemo(() => chunkAddress(address), [address]);
  const ariaLabel = useMemo(() => chunks.join(" "), [chunks]);
  const showFull = !compact || expanded;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 align-middle", className)}
      onMouseEnter={compact ? () => setExpanded(true) : undefined}
      onMouseLeave={compact ? () => setExpanded(false) : undefined}
      onFocus={compact ? () => setExpanded(true) : undefined}
      onBlur={compact ? () => setExpanded(false) : undefined}
      tabIndex={compact ? 0 : undefined}
    >
      {showIdenticon && <AddressIdenticon address={address} size={16} />}
      <Ltr className="break-all">
        <span aria-label={ariaLabel}>
          {showFull ? chunks.join(" ") : shortAddress(address, 4, 4)}
        </span>
      </Ltr>
    </span>
  );
}
