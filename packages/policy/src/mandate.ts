import type { Mandate, PurchaseIntent, ReasonCode, SpendState, Verdict } from "./types";

export interface MandateDecision {
  allow: boolean;
  reasons: ReasonCode[];
}

// Numeric limits are enforced in code on both the agent and the server. The
// on-task check needs a judge verdict; the server runs without it (it cannot
// know the user's question) and passes `verdict` as undefined.
export function checkMandate(
  intent: PurchaseIntent,
  mandate: Mandate,
  spend: SpendState,
  verdict?: Pick<Verdict, "onTask">,
): MandateDecision {
  const reasons: ReasonCode[] = [];
  if (intent.currency !== mandate.currency) reasons.push("CURRENCY_MISMATCH");
  if (intent.priceMinor > mandate.maxPerPurchaseMinor) reasons.push("OVER_PER_PURCHASE_LIMIT");
  if (spend.spentThisMonthMinor + intent.priceMinor > mandate.budgetMonthlyMinor) {
    reasons.push("OVER_MONTHLY_BUDGET");
  }
  if (mandate.allowedPublishers?.length && !mandate.allowedPublishers.includes(intent.publisherId)) {
    reasons.push("PUBLISHER_NOT_ALLOWED");
  }
  if (verdict && (verdict.onTask ?? 0) < mandate.onTaskMinProbability) reasons.push("OFF_TASK");
  return { allow: reasons.length === 0, reasons };
}
