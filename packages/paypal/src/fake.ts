import type { Money } from "./money";
import { PayPalError, type DisputeSummary, type PayPalApi } from "./types";

interface FakeCapture {
  captureId: string;
  orderId: string;
  amount: Money;
  refundedMinor: number;
  customId: string;
}

// Deterministic stand-in for tests and for running the demo without sandbox
// credentials. It enforces the rules that matter to us: idempotency keys, no
// refund above the captured amount, vault ids must exist.
export class FakePayPal implements PayPalApi {
  readonly mode = "fake" as const;
  // In the keyless demo there is no PayPal page to click, so setup tokens count as approved.
  constructor(private readonly opts: { autoApprove?: boolean } = {}) {}
  private seq = 0;
  private setupTokens = new Map<string, { approved: boolean }>();
  private vaults = new Set<string>();
  private orders = new Map<string, { amount: Money; customId: string; captured?: string }>();
  readonly captures = new Map<string, FakeCapture>();
  readonly payouts = new Map<string, { items: { senderItemId: string; amount: Money; receiverEmail: string }[] }>();
  private idempotent = new Map<string, unknown>();

  private id(prefix: string) {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, "0")}`;
  }

  private once<T>(requestId: string, fn: () => T): T {
    if (this.idempotent.has(requestId)) return this.idempotent.get(requestId) as T;
    const result = fn();
    this.idempotent.set(requestId, result);
    return result;
  }

  // Test helper: what the owner does in the PayPal popup.
  approveSetupToken(setupTokenId: string) {
    const t = this.setupTokens.get(setupTokenId);
    if (!t) throw new Error(`unknown setup token ${setupTokenId}`);
    t.approved = true;
  }

  async createVaultSetupToken(input: { returnUrl: string; cancelUrl: string }) {
    const setupTokenId = this.id("SETUP");
    this.setupTokens.set(setupTokenId, { approved: false });
    return { setupTokenId, approveUrl: `${input.returnUrl}?approval_token_id=${setupTokenId}&fake=1` };
  }

  async createPaymentToken(setupTokenId: string) {
    const t = this.setupTokens.get(setupTokenId);
    if (!t) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND", undefined, null);
    if (!t.approved && !this.opts.autoApprove) throw new PayPalError("setup token not approved", 422, "UNPROCESSABLE_ENTITY", undefined, null);
    const vaultId = this.id("VAULT");
    this.vaults.add(vaultId);
    return { vaultId, payerEmail: "owner@personal.example.com", payerId: "FAKEPAYER" };
  }

  async chargeVault(input: { vaultId: string; amount: Money; description: string; customId: string; requestId: string }) {
    return this.once(input.requestId, () => {
      if (!this.vaults.has(input.vaultId)) {
        throw new PayPalError("vault id not found", 422, "UNPROCESSABLE_ENTITY", undefined, null);
      }
      const orderId = this.id("ORDER");
      const captureId = this.id("CAPTURE");
      this.orders.set(orderId, { amount: input.amount, customId: input.customId, captured: captureId });
      this.captures.set(captureId, { captureId, orderId, amount: input.amount, refundedMinor: 0, customId: input.customId });
      return { orderId, captureId, status: "COMPLETED" };
    });
  }

  async createTopupOrder(input: { amount: Money; customId: string; returnUrl: string; cancelUrl: string; requestId: string }) {
    return this.once(input.requestId, () => {
      const orderId = this.id("ORDER");
      this.orders.set(orderId, { amount: input.amount, customId: input.customId });
      return { orderId, approveUrl: `${input.returnUrl}?token=${orderId}&fake=1` };
    });
  }

  async captureOrder(orderId: string, requestId: string) {
    return this.once(requestId, () => {
      const o = this.orders.get(orderId);
      if (!o) throw new PayPalError("order not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
      if (o.captured) throw new PayPalError("order already captured", 422, "ORDER_ALREADY_CAPTURED", undefined, null);
      const captureId = this.id("CAPTURE");
      o.captured = captureId;
      this.captures.set(captureId, { captureId, orderId, amount: o.amount, refundedMinor: 0, customId: o.customId });
      return { captureId, status: "COMPLETED", amount: o.amount, customId: o.customId };
    });
  }

  async refundCapture(input: { captureId: string; amount: Money; note: string; requestId: string }) {
    return this.once(input.requestId, () => {
      const c = this.captures.get(input.captureId);
      if (!c) throw new PayPalError("capture not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
      if (input.amount.currency !== c.amount.currency) {
        throw new PayPalError("currency mismatch", 422, "UNPROCESSABLE_ENTITY", undefined, null);
      }
      if (c.refundedMinor + input.amount.minor > c.amount.minor) {
        throw new PayPalError("refund exceeds captured amount", 422, "REFUND_AMOUNT_EXCEEDED", undefined, null);
      }
      c.refundedMinor += input.amount.minor;
      return { refundId: this.id("REFUND"), status: "COMPLETED" };
    });
  }

  async createPayout(input: {
    senderBatchId: string;
    emailSubject: string;
    items: { receiverEmail: string; amount: Money; note: string; senderItemId: string }[];
  }) {
    return this.once(`payout:${input.senderBatchId}`, () => {
      const payoutBatchId = this.id("PAYOUT");
      this.payouts.set(payoutBatchId, { items: input.items });
      return { payoutBatchId, status: "PENDING" };
    });
  }

  async getPayout(payoutBatchId: string) {
    const p = this.payouts.get(payoutBatchId);
    if (!p) throw new PayPalError("payout not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
    return { status: "SUCCESS", items: p.items.map((i) => ({ senderItemId: i.senderItemId, status: "SUCCESS" })) };
  }

  async verifyWebhook() {
    return true;
  }

  // ---------- disputes ----------
  readonly disputes = new Map<string, { disputeId: string; captureId: string; status: string; reason: string; amount: Money; evidence: string[] }>();

  // Test helper: what the buyer does in the sandbox Resolution Center.
  openDispute(captureId: string, reason = "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    const c = this.captures.get(captureId);
    if (!c) throw new Error(`unknown capture ${captureId}`);
    const disputeId = this.id("PP-D");
    this.disputes.set(disputeId, { disputeId, captureId, status: "WAITING_FOR_SELLER_RESPONSE", reason, amount: c.amount, evidence: [] });
    return disputeId;
  }

  async listDisputes(): Promise<DisputeSummary[]> {
    return [...this.disputes.values()]
      .filter((d) => d.status === "WAITING_FOR_SELLER_RESPONSE")
      .map((d) => ({ disputeId: d.disputeId, status: d.status, reason: d.reason, amount: d.amount }));
  }

  async getDispute(disputeId: string) {
    const d = this.disputes.get(disputeId);
    if (!d) throw new PayPalError("dispute not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
    return { disputeId, status: d.status, reason: d.reason, captureIds: [d.captureId], links: ["provide_evidence", "accept_claim"] };
  }

  async provideDisputeEvidence(disputeId: string, notes: string) {
    const d = this.disputes.get(disputeId);
    if (!d) throw new PayPalError("dispute not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
    d.evidence.push(notes);
    d.status = "UNDER_REVIEW";
  }

  async acceptDisputeClaim(disputeId: string, _note: string, refund?: Money) {
    const d = this.disputes.get(disputeId);
    if (!d) throw new PayPalError("dispute not found", 404, "RESOURCE_NOT_FOUND", undefined, null);
    const c = this.captures.get(d.captureId)!;
    c.refundedMinor += refund?.minor ?? c.amount.minor - c.refundedMinor;
    d.status = "RESOLVED";
  }
}
