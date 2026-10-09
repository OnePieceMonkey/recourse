import type { Money } from "./money";

// The operations Recourse needs from PayPal. The REST client and the in-memory
// fake both implement this, so the facilitator never knows which one it talks to.
export interface PayPalApi {
  readonly mode: "sandbox" | "fake";

  // Owner connects PayPal once (Vault v3, save without purchase).
  createVaultSetupToken(input: { returnUrl: string; cancelUrl: string }): Promise<{ setupTokenId: string; approveUrl: string }>;
  createPaymentToken(setupTokenId: string): Promise<{ vaultId: string; payerEmail?: string; payerId?: string }>;

  // Merchant-initiated charge against the vault, no buyer present.
  chargeVault(input: {
    vaultId: string;
    amount: Money;
    description: string;
    customId: string; // our purchase id, shows up in PayPal reports
    requestId: string; // idempotency key
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
