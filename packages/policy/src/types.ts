// Inputs to the policy are plain data so this package has no dependency on the
// wire format, the judge vendor or PayPal. Money is always integer minor units.

export const POLICY_VERSION = "2026-10-09.1";

export interface Mandate {
  version: number;
  currency: string; // ISO 4217, e.g. "EUR"
  budgetMonthlyMinor: number;
  maxPerPurchaseMinor: number;
  allowedPublishers?: string[]; // empty or missing = any registered publisher
  onTaskMinProbability: number; // 0..1, required p("on_task") from the judge
}

export interface PurchaseIntent {
  publisherId: string;
  priceMinor: number;
  currency: string;
}

export interface SpendState {
  spentThisMonthMinor: number;
}

// Probabilities from a decision model. Every field is optional because a judge
// can fail; the policy treats missing evidence conservatively.
export interface Verdict {
  model: string;
  promise?: { yes: number; partially: number; no: number };
  injection?: number; // p(text contains instructions aimed at the agent)
  usefulness?: number; // expected score on 1..5
  onTask?: number; // p(purchase is on-task for the user's request)
}

export interface ClaimThresholds {
  injection: number;
  notAsDescribed: number;
  partially: number;
  partialRefundBps: number; // basis points of the price refunded for "partially"
  // Adjudication: Recourse's own judge must clearly disagree before a claim is rejected.
  rejectBelow: number;
}

export const DEFAULT_THRESHOLDS: ClaimThresholds = {
  injection: 0.5,
  notAsDescribed: 0.7,
  partially: 0.7,
  partialRefundBps: 5000,
  rejectBelow: 0.3,
};

export type ReasonCode =
  | "HASH_MISMATCH"
  | "PROMPT_INJECTION"
  | "NOT_AS_DESCRIBED"
  | "PARTIALLY_AS_DESCRIBED"
  | "JUDGE_UNAVAILABLE"
  | "OVER_PER_PURCHASE_LIMIT"
  | "OVER_MONTHLY_BUDGET"
  | "CURRENCY_MISMATCH"
  | "PUBLISHER_NOT_ALLOWED"
  | "OFF_TASK"
  | "EVIDENCE_DOES_NOT_MATCH_COMMITMENT"
  | "JUDGES_DISAGREE"
  | "OUTSIDE_PROTECTION_WINDOW";
