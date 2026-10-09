import {
  buildPaymentPayload,
  decodeHeader,
  encodeHeader,
  EXT_RECEIPT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_RECOURSE_DELIVERY,
  offerFromPaymentRequired,
  PaymentRequiredSchema,
  requirementsMatchOffer,
  SettlementResponseSchema,
  SignedDeliverySchema,
  type PaymentRequired,
  type SignedDelivery,
  type SignedOffer,
} from "@recourse/protocol";
import type { LogEntry, Signer } from "@recourse/receipts";

export interface PaidReceipt {
  purchaseId: string;
  funding: "balance" | "paypal_vault";
  paypalCaptureId?: string;
  receipt: LogEntry;
}

export type PayResult =
  | { kind: "free"; status: number; body: Uint8Array }
  | { kind: "skipped"; offer: SignedOffer; reason: string }
  | { kind: "refused"; offer: SignedOffer; reason: string; message?: string }
  | { kind: "paid"; offer: SignedOffer; body: Uint8Array; delivery?: SignedDelivery; receipt: PaidReceipt };

export interface PayOptions {
  agentId: string;
  agentSigner: Signer;
  // Called with the signed offer before any money moves; return a reason to skip.
  beforePay: (offer: SignedOffer, pr: PaymentRequired) => Promise<{ pay: true } | { pay: false; reason: string }>;
  fetchImpl?: typeof fetch;
}

// x402 client for the Recourse binding: read the 402, let the caller decide,
// sign an authorization for exactly that offer, retry, collect body + receipt.
export async function payingFetch(url: string, opts: PayOptions): Promise<PayResult> {
  const f = opts.fetchImpl ?? fetch;
  const first = await f(url);
  if (first.status !== 402) return { kind: "free", status: first.status, body: new Uint8Array(await first.arrayBuffer()) };

  const header = first.headers.get(HEADER_PAYMENT_REQUIRED);
  if (!header) throw new Error(`${url}: 402 without ${HEADER_PAYMENT_REQUIRED} header`);
  const pr = decodeHeader(header, PaymentRequiredSchema);
  const offer = offerFromPaymentRequired(pr);
  const requirement = pr.accepts.find((r) => requirementsMatchOffer(r, offer));
  if (!requirement) return { kind: "skipped", offer, reason: "REQUIREMENTS_DO_NOT_MATCH_SIGNED_OFFER" };

  const decision = await opts.beforePay(offer, pr);
  if (!decision.pay) return { kind: "skipped", offer, reason: decision.reason };

  const payload = buildPaymentPayload({ agentId: opts.agentId, agentSigner: opts.agentSigner, paymentRequired: pr, requirement, offer });
  const paid = await f(url, { headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(payload) } });
  const settlementHeader = paid.headers.get(HEADER_PAYMENT_RESPONSE);
  const settlement = settlementHeader ? decodeHeader(settlementHeader, SettlementResponseSchema) : undefined;
  if (paid.status !== 200 || !settlement?.success) {
    const body = (await paid.json().catch(() => ({}))) as { error?: string; message?: string };
    return { kind: "refused", offer, reason: settlement?.errorReason ?? body.error ?? `HTTP_${paid.status}`, message: settlement?.errorMessage ?? body.message };
  }
  const info = (settlement.extensions?.[EXT_RECEIPT] as { info?: PaidReceipt } | undefined)?.info;
  if (!info) throw new Error(`${url}: settlement without ${EXT_RECEIPT}`);
  const deliveryHeader = paid.headers.get(HEADER_RECOURSE_DELIVERY);
  const delivery = deliveryHeader ? decodeHeader(deliveryHeader, SignedDeliverySchema) : undefined;
  return {
    kind: "paid",
    offer,
    body: new Uint8Array(await paid.arrayBuffer()),
    ...(delivery ? { delivery } : {}),
    receipt: { purchaseId: info.purchaseId, funding: info.funding, ...(info.paypalCaptureId ? { paypalCaptureId: info.paypalCaptureId } : {}), receipt: info.receipt },
  };
}
