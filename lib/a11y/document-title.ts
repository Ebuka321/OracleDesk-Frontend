"use client";

import { useEffect } from "react";

/** Sets a page-specific document title and restores the previous title on unmount. */
export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
