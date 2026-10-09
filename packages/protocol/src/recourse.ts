import { z } from "zod";
import { hashCanonical, verifySignature, type PublicJwk, type Signer } from "@recourse/receipts";

// Recourse's own objects. They travel inside the x402 envelope (see x402.ts) but
// are defined and signed independently of it, so the protection logic does not
// depend on any particular transport version.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const minor = z.number().int().nonnegative();

export const MoneySchema = z.object({ currency: z.string().length(3), minor });
export type MoneyT = z.infer<typeof MoneySchema>;

export const OfferBodySchema = z.object({
  v: z.literal(1),
  offerId: z.string().min(8),
  publisherId: z.string().min(1),
  resource: z.string().url(),
  price: MoneySchema,
  contentSha256: sha256,
  contentLength: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
  title: z.string().max(200),
  // What the buyer is promised, in plain language. This is what claims are judged against.
  promise: z.string().min(10).max(500),
  license: z.string().max(100),
  protectionWindowSec: z.number().int().positive(),
  expiresAt: z.string().datetime(),
});
export type OfferBody = z.infer<typeof OfferBodySchema>;

export const SignedSchema = <T extends z.ZodTypeAny>(body: T) => z.object({ body, kid: z.string(), sig: z.string() });

export const SignedOfferSchema = SignedSchema(OfferBodySchema);
export type SignedOffer = z.infer<typeof SignedOfferSchema>;

// Sent by the gate with every delivered body: the publisher's signature over the
// hash of the bytes it actually sent. This is what makes bait-and-switch provable.
export const DeliveryBodySchema = z.object({
  v: z.literal(1),
  offerId: z.string(),
  purchaseId: z.string(),
  deliveredSha256: sha256,
  deliveredAt: z.string().datetime(),
});
export type DeliveryBody = z.infer<typeof DeliveryBodySchema>;
export const SignedDeliverySchema = SignedSchema(DeliveryBodySchema);
export type SignedDelivery = z.infer<typeof SignedDeliverySchema>;

export const FundingSchema = z.enum(["balance", "paypal_vault"]);

// Data of a "receipt" entry in the transparency log.
export const ReceiptDataSchema = z.object({
  purchaseId: z.string(),
  offerId: z.string(),
  offerHash: sha256,
  offerSig: z.string(),
  publisherId: z.string(),
  ownerId: z.string(),
  agentId: z.string(),
  price: MoneySchema,
  funding: FundingSchema,
  paypalCaptureId: z.string().optional(),
  mandateVersion: z.number().int(),
  mandateHash: sha256,
  protectionUntil: z.string().datetime(),
});
export type ReceiptData = z.infer<typeof ReceiptDataSchema>;

export const ReasonCodeSchema = z.enum([
  "HASH_MISMATCH",
  "PROMPT_INJECTION",
  "NOT_AS_DESCRIBED",
  "PARTIALLY_AS_DESCRIBED",
  "JUDGE_UNAVAILABLE",
  "OVER_PER_PURCHASE_LIMIT",
  "OVER_MONTHLY_BUDGET",
  "CURRENCY_MISMATCH",
  "PUBLISHER_NOT_ALLOWED",
  "OFF_TASK",
  "EVIDENCE_DOES_NOT_MATCH_COMMITMENT",
  "JUDGES_DISAGREE",
  "OUTSIDE_PROTECTION_WINDOW",
]);

export const VerdictSchema = z.object({
  model: z.string(),
  promise: z.object({ yes: z.number(), partially: z.number(), no: z.number() }).optional(),
  injection: z.number().min(0).max(1).optional(),
  usefulness: z.number().optional(),
  onTask: z.number().min(0).max(1).optional(),
});

export const ClaimRequestSchema = z.object({
  purchaseId: z.string(),
  reasons: z.array(ReasonCodeSchema).min(1),
  refundBps: z.number().int().min(1).max(10000),
  delivery: SignedDeliverySchema.optional(),
  // The delivered bytes, base64. Recourse recomputes their hash itself.
  bodyBase64: z.string(),
  agentVerdict: VerdictSchema.optional(),
  flaggedExcerpt: z.string().max(2000).optional(),
  policyVersion: z.string(),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimResultSchema = z.object({
  claimId: z.string(),
  purchaseId: z.string(),
  outcome: z.enum(["REFUND", "REJECT", "CONTESTED"]),
  refundBps: z.number().int(),
  refund: MoneySchema,
  reasons: z.array(ReasonCodeSchema),
  logSeq: z.number().int(),
  paypalRefundId: z.string().optional(),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export function signBody<T extends object>(signer: Signer, body: T): { body: T; kid: string; sig: string } {
  return { body, kid: signer.kid, sig: signer.sign(body) };
}

export function verifySigned(publicJwk: PublicJwk, signed: { body: unknown; sig: string }): boolean {
  return verifySignature(publicJwk, signed.body, signed.sig);
}

export function offerHash(offer: OfferBody): string {
  return hashCanonical(offer);
}
