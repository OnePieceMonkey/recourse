import type { Money } from "./money";

// The operations Recourse needs from PayPal. The REST client and the in-memory
// fake both implement this, so the facilitator never knows which one it talks to.
export interface PayPalApi {
  readonly mode: "sandbox" | "fake";

  // Owner connects PayPal once (Vault v3, save without purchase).
  createVaultSetupToken(input: { returnUrl: string; cancelUrl: string; description?: string; customerId?: string }): Promise<{ setupTokenId: string; approveUrl: string }>;
  createPaymentToken(setupTokenId: string): Promise<{ vaultId: string; payerEmail?: string; payerId?: string }>;

  // Merchant-initiated charge against the vault, no buyer present.
  chargeVault(input: {
    vaultId: string;
    amount: Money;
    description: string;
    customId: string; // our purchase id, shows up in PayPal reports
    requestId: string; // idempotency key
    url?: string;
  }): Promise<{ orderId: string; captureId: string; status: string }>;

  // One-time checkout to top up the prepaid balance.
  createTopupOrder(input: { amount: Money; customId: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<{
    orderId: string;
    approveUrl: string;
  }>;
  captureOrder(orderId: string, requestId: string): Promise<{ captureId: string; status: string; amount: Money; customId?: string }>;

  refundCapture(input: { captureId: string; amount: Money; note: string; requestId: string }): Promise<{ refundId: string; status: string }>;

  createPayout(input: {
    senderBatchId: string;
    emailSubject: string;
    items: { receiverEmail: string; amount: Money; note: string; senderItemId: string }[];
  }): Promise<{ payoutBatchId: string; status: string }>;
  getPayout(payoutBatchId: string): Promise<{ status: string; items: { senderItemId: string; status: string }[] }>;

  verifyWebhook(input: { headers: Record<string, string | undefined>; body: string; webhookId: string }): Promise<boolean>;

  // Merchant side of PayPal disputes. Cases are opened by the buyer (in the sandbox:
  // by hand in the Resolution Center); Recourse answers them with its evidence.
  listDisputes(state?: string): Promise<DisputeSummary[]>;
  getDispute(disputeId: string): Promise<{ disputeId: string; status: string; reason: string; captureIds: string[]; links: string[] }>;
  provideDisputeEvidence(disputeId: string, notes: string, files?: { filename: string; type: string; data: Uint8Array }[]): Promise<void>;
  acceptDisputeClaim(disputeId: string, note: string, refund?: Money): Promise<void>;
}

export interface DisputeSummary {
  disputeId: string;
  status: string;
  reason: string;
  amount?: Money | undefined;
  createTime?: string;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly name_: string | undefined,
    readonly debugId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}
