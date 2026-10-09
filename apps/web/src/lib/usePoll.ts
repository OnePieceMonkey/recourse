"use client";

import { useEffect, useRef } from "react";

// Calls `fn` now and then every `ms` while the tab is visible.
export function usePoll(fn: () => void | Promise<void>, ms: number, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    void ref.current();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void ref.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}
