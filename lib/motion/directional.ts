import type { Dir } from "@/lib/i18n/direction";

/**
 * Direction-aware horizontal slide-in variants for framer-motion.
 * In LTR, items enter from the inline-start (left, negative x) and exit to inline-end (right, positive x).
 * In RTL, items enter from the inline-start (right, positive x) and exit to inline-end (left, negative x).
 */
export function slideIn(dir: Dir, distance = 20) {
  const sign = dir === "rtl" ? 1 : -1;
  return {
    initial: { opacity: 0, x: sign * distance },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -sign * distance },
  };
}
