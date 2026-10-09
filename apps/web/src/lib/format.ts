import type { Money, ReasonCode } from "./types";

export function formatMinor(minor: number, currency = "EUR"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

export const formatMoney = (m: Money) => formatMinor(m.minor, m.currency);

export const pct = (p: number | undefined) => (p === undefined ? "n/a" : `${Math.round(p * 100)}%`);

export function shortHash(h: string | null | undefined, head = 8, tail = 4): string {
  if (!h) return "n/a";
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d).replace(",", "");
}

export function formatClock(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

export const FUNDING_LABEL = { balance: "Prepaid balance", paypal_vault: "PayPal vault" } as const;
export const FUNDING_SHORT = { balance: "Balance", paypal_vault: "PayPal vault" } as const;
export const FUNDING_LONG = {
  balance: "Prepaid balance",
  paypal_vault: "PayPal vault, no human present",
} as const;

const REASON_LABEL: Record<string, string> = {
  HASH_MISMATCH: "Hash mismatch",
  PROMPT_INJECTION: "Prompt injection",
  NOT_AS_DESCRIBED: "Not as described",
  PARTIALLY_AS_DESCRIBED: "Partly as described",
  JUDGE_UNAVAILABLE: "Judge unavailable",
  OVER_PER_PURCHASE_LIMIT: "Over per-purchase limit",
  OVER_MONTHLY_BUDGET: "Over monthly budget",
  CURRENCY_MISMATCH: "Currency mismatch",
  PUBLISHER_NOT_ALLOWED: "Publisher not allowed",
  OFF_TASK: "Off task",
  EVIDENCE_DOES_NOT_MATCH_COMMITMENT: "Evidence does not match commitment",
  JUDGES_DISAGREE: "Judges disagree",
  OUTSIDE_PROTECTION_WINDOW: "Outside protection window",
};

export const reasonLabel = (r: ReasonCode | string) => REASON_LABEL[r] ?? r;

// Claim thresholds the agent's policy uses (packages/policy DEFAULT_THRESHOLDS).
// Shown as tick marks on the probability bars; the numbers themselves come from the model.
export const THRESHOLDS = { injection: 0.5, notAsDescribed: 0.7, partially: 0.7 } as const;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
