"use client";

import { useState } from "react";
import { shortHash } from "@/lib/format";

export function Hash({ value, head = 8, tail = 4, label }: { value: string | null | undefined; head?: number; tail?: number; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="mono muted">n/a</span>;
  return (
    <button
      type="button"
      className="hash"
      title={`${value} (click to copy)`}
      aria-label={`${label ?? "Hash"} ${value}. Copy`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "copied" : shortHash(value, head, tail)}
    </button>
  );
}
