import { FUNDING_LABEL, formatMoney, reasonLabel } from "./format";
import type { LogEntry, LogEntryType, Money } from "./types";

export const TYPE_LABEL: Record<LogEntryType, string> = {
  receipt: "Receipt",
  settlement_refused: "Refused",
  claim_decision: "Claim decision",
  dispute_response: "Dispute response",
  payout: "Payout",
  anchor: "Anchor",
};

export const TYPE_TONE: Record<LogEntryType, "mint" | "sky" | "rose" | "butter" | "plain"> = {
  receipt: "mint",
  settlement_refused: "butter",
  claim_decision: "sky",
  dispute_response: "butter",
  payout: "plain",
  anchor: "plain",
};

const isMoney = (v: unknown): v is Money => !!v && typeof v === "object" && typeof (v as Money).minor === "number" && typeof (v as Money).currency === "string";
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));

// One line for lists.
export function summarize(e: LogEntry): string {
  const d = e.data;
  switch (e.type) {
    case "receipt": {
      const price = isMoney(d.price) ? formatMoney(d.price) : "";
      const funding = FUNDING_LABEL[d.funding as keyof typeof FUNDING_LABEL] ?? str(d.funding);
      return `${price} · ${funding} · ${str(d.publisherId)}`;
    }
    case "claim_decision": {
      const refund = isMoney(d.refund) ? formatMoney(d.refund) : "";
      const why = Array.isArray(d.decided) ? (d.decided as string[]).map(reasonLabel).join(", ") : "";
      return `${str(d.outcome)} · ${refund}${why ? ` · ${why}` : ""}`;
    }
    case "settlement_refused":
      return `${str(d.reason)} · ${str(d.publisherId) || "unknown publisher"}`;
    case "payout": {
      const items = Array.isArray(d.items) ? (d.items as { amount?: Money }[]) : [];
      const total = items.reduce((a, i) => a + (i.amount?.minor ?? 0), 0);
      return `${items.length} payee${items.length === 1 ? "" : "s"} · ${formatMoney({ currency: items[0]?.amount?.currency ?? "EUR", minor: total })}`;
    }
    case "dispute_response":
      return `${str(d.action)} · ${str(d.reason)}`;
    default:
      return Object.keys(d).slice(0, 3).join(", ");
  }
}

export interface Field {
  label: string;
  value: string;
  kind: "text" | "hash" | "money" | "mono";
}

const LABELS: Record<string, string> = {
  purchaseId: "Purchase",
  offerId: "Offer",
  offerHash: "Offer hash",
  offerSig: "Publisher signature on the offer",
  publisherId: "Publisher",
  ownerId: "Owner",
  agentId: "Agent",
  price: "Price",
  funding: "Funding",
  paypalCaptureId: "PayPal capture",
  mandateVersion: "Mandate version",
  mandateHash: "Mandate hash",
  deliveredSha256: "Delivered SHA-256",
  deliveredLength: "Delivered bytes",
  protectionUntil: "Protected until",
  claimId: "Claim",
  receiptSeq: "Receipt entry",
  claimed: "Claimed",
  outcome: "Outcome",
  decided: "Decided on",
  refund: "Refund",
  submittedSha256: "Submitted SHA-256",
  committedSha256: "Committed SHA-256",
  policyVersion: "Policy version",
  paypalRefundId: "PayPal refund",
  reason: "Reason",
  payoutId: "Payout",
  paypalBatchId: "PayPal batch",
  disputeId: "Dispute",
  action: "Action",
};

const HASHY = /(hash|sha256|sig|id)$/i;

const ORDER = ["price", "refund", "outcome", "claimed", "decided", "reason", "action", "publisherId", "funding", "purchaseId", "claimId", "receiptSeq", "offerId"];

export function fieldsOf(e: LogEntry): Field[] {
  const out: Field[] = [];
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i === -1 ? ORDER.length : i;
  };
  const entries = Object.entries(e.data).sort(([a], [b]) => rank(a) - rank(b));
  for (const [k, v] of entries) {
    if (v === null || v === undefined || k === "agentVerdict" || k === "ownVerdict") continue;
    const label = LABELS[k] ?? k;
    if (isMoney(v)) out.push({ label, value: formatMoney(v), kind: "money" });
    else if (k === "funding") out.push({ label, value: FUNDING_LABEL[v as keyof typeof FUNDING_LABEL] ?? str(v), kind: "text" });
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) out.push({ label, value: (v as string[]).map(reasonLabel).join(", "), kind: "text" });
    else if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out.push({ label, value: v, kind: "hash" });
    else if (typeof v === "string" && HASHY.test(k) && v.length > 14) out.push({ label, value: v, kind: "hash" });
    else if (typeof v === "object") out.push({ label, value: JSON.stringify(v), kind: "mono" });
    else out.push({ label, value: str(v), kind: "text" });
  }
  return out;
}

// For the tamper demo: change something a buyer or publisher would care about.
export function tamper(e: LogEntry): { entry: LogEntry; what: string } {
  const data = structuredClone(e.data);
  if (isMoney(data.price)) {
    const before = data.price.minor;
    data.price.minor = Math.max(1, Math.floor(before / 10));
    return { entry: { ...e, data }, what: `price ${formatMoney({ currency: data.price.currency, minor: before })} became ${formatMoney(data.price)}` };
  }
  if (isMoney(data.refund)) {
    const before = data.refund.minor;
    data.refund.minor = before + 100;
    return { entry: { ...e, data }, what: `refund ${formatMoney({ currency: data.refund.currency, minor: before })} became ${formatMoney(data.refund)}` };
  }
  if (typeof data.outcome === "string") {
    const before = data.outcome;
    data.outcome = before === "REFUND" ? "REJECT" : "REFUND";
    return { entry: { ...e, data }, what: `outcome ${before} became ${data.outcome}` };
  }
  const at = new Date(e.at);
  at.setUTCDate(at.getUTCDate() - 1);
  return { entry: { ...e, at: at.toISOString() }, what: "timestamp moved back by one day" };
}
