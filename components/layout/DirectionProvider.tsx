"use client";

import type { ReactNode } from "react";
import { Direction } from "radix-ui";
import type { Dir } from "@/lib/i18n/direction";

export function DirectionProvider({
  dir,
  children,
}: {
  dir: Dir;
  children: ReactNode;
}) {
  return <Direction.DirectionProvider dir={dir}>{children}</Direction.DirectionProvider>;
}

export function useDirection(): Dir {
  return Direction.useDirection();
}
