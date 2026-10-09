// Shapes of the backend payloads the web app reads. They mirror packages/protocol,
// packages/receipts and packages/policy, kept local so the web app has no workspace
// dependency on server-only code.

export interface Money {
  currency: string;
  minor: number;
}

export type LogEntryType = "receipt" | "settlement_refused" | "claim_decision" | "dispute_response" | "payout" | "anchor";

export interface LogEntryBody {
  seq: number;
  type: LogEntryType;
  prevHash: string;
  at: string;
  data: Record<string, unknown>;
}

export interface LogEntry extends LogEntryBody {
  hash: string;
  sig: string;
  kid: string;
}

export interface LogPage {
  entries: LogEntry[];
  headSeq: number;
}

export interface AnchorProof {
  headSeq: number;
  headHash: string;
  method: "opentimestamps" | "none";
  proof: string;
  status: "pending" | "confirmed";
  bitcoinBlock?: number;
}

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface KeyDoc {
  kid: string;
  publicJwk: PublicJwk;
  network: string;
}

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

export type Funding = "balance" | "paypal_vault";

export interface Verdict {
  model: string;
  promise?: { yes: number; partially: number; no: number };
  injection?: number;
  usefulness?: number;
  onTask?: number;
}

export interface HiddenSegment {
  kind: string;
  text: string;
  where?: string;
  count?: number;
}

export interface JudgeDetails {
  model?: string;
  latencyMs?: number;
  hidden?: HiddenSegment[];
  signals?: string[];
  error?: string;
}

export interface ClaimDecision {
  action: "accept" | "claim";
  refundBps: number;
  quarantine: boolean;
  reasons: ReasonCode[];
}

export interface ClaimResult {
  claimId: string;
  purchaseId: string;
  outcome: "REFUND" | "REJECT" | "CONTESTED";
  refundBps: number;
  refund: Money;
  reasons: ReasonCode[];
  logSeq: number;
  paypalRefundId?: string;
}

export interface OfferBody {
  v: 1;
  offerId: string;
  publisherId: string;
  resource: string;
  price: Money;
  contentSha256: string;
  contentLength: number;
  mimeType: string;
  title: string;
  promise: string;
  license: string;
  protectionWindowSec: number;
  expiresAt: string;
}

export interface CatalogEntry {
  url: string;
  publisher: string;
  publisherId: string;
  title: string;
  promise: string;
  price: Money;
  mimeType: string;
}

export interface PaidReceipt {
  purchaseId: string;
  funding: Funding;
  paypalCaptureId?: string;
  receipt: LogEntry;
}

export interface Answer {
  answer: string;
  citations: { url: string; quote: string }[];
}

// What the agent server streams (apps/agent/src/research.ts `AgentEvent`).
export type AgentEvent =
  | { type: "start"; question: string; writer: string; judge: string }
  | { type: "catalog"; items: CatalogEntry[] }
  | { type: "plan"; picks: { url: string; title: string; price: Money; reason: string }[] }
  | { type: "offer"; url: string; offer: OfferBody }
  | { type: "mandate"; url: string; allow: boolean; reasons: ReasonCode[]; onTask?: number }
  | { type: "paid"; url: string; receipt: PaidReceipt; price: Money }
  | { type: "refused"; url: string; reason: string; message?: string }
  | { type: "verified"; url: string; hashMatches: boolean; verdict: Verdict; details: JudgeDetails | null; decision: ClaimDecision }
  | { type: "claim"; url: string; result: ClaimResult }
  | { type: "answer"; answer: Answer }
  | {
      type: "summary";
      spentMinor: number;
      refundedMinor: number;
      blocked: number;
      refused: number;
      quarantined: number;
      used: number;
    }
  | { type: "error"; message: string };

export interface Mandate {
  version: number;
  currency: string;
  budgetMonthlyMinor: number;
  maxPerPurchaseMinor: number;
  allowedPublishers?: string[];
  onTaskMinProbability: number;
}

export interface OwnerListItem {
  id: string;
  name: string;
  paypal_connected: boolean;
  created_at: string;
}

export interface OwnerPurchase {
  id: string;
  publisher_id: string;
  title: string;
  price_minor: number;
  currency: string;
  funding: Funding;
  status: string;
  refunded_minor: number;
  receipt_seq: number | null;
  created_at: string;
  claim_outcome: string | null;
  decided_reasons: ReasonCode[] | null;
  paypal_refund_id: string | null;
}

export interface OwnerStats {
  owner: { id: string; name: string; paypalConnected: boolean; payerEmail: string | null };
  balanceMinor: number;
  spentThisMonthMinor: number;
  mandate?: Mandate;
  purchases: OwnerPurchase[];
}

export interface PublisherListItem {
  id: string;
  name: string;
  kid: string;
  created_at: string;
}

export interface PublisherPurchase {
  id: string;
  title: string;
  price_minor: number;
  currency: string;
  funding: Funding;
  status: string;
  refunded_minor: number;
  created_at: string;
  earning_status: "PENDING" | "PAID" | "CANCELLED";
  earning_minor: number;
  claim_outcome: string | null;
  decided_reasons: ReasonCode[] | null;
}

export interface PublisherStats {
  publisherId: string;
  purchases: PublisherPurchase[];
}

export interface ClaimRow {
  id: string;
  purchase_id: string;
  outcome: "REFUND" | "REJECT" | "CONTESTED";
  refund_minor: number;
  decided_reasons: ReasonCode[];
  reasons: ReasonCode[];
  paypal_refund_id: string | null;
  log_seq: number;
  created_at: string;
  title: string;
  publisher_id: string;
  price_minor: number;
  currency: string;
  funding: Funding;
}
