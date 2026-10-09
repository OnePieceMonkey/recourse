import { z } from "zod";
import { DeliveryBodySchema, OfferBodySchema, SignedOfferSchema, SignedSchema, offerHash, type SignedOffer } from "./recourse";

// x402 V2 transport (specs/transports-v2/http.md): three headers, each standard
// base64 of UTF-8 JSON. Recourse binds the `auth-capture` scheme, the x402 scheme
// whose stated purpose is refundable payments with buyer protection, to PayPal.
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";
export const HEADER_RECOURSE_DELIVERY = "RECOURSE-DELIVERY";

export const X402_VERSION = 2;
export const SCHEME = "auth-capture";
export const NETWORK_SANDBOX = "paypal:sandbox";
export const BINDING = "recourse-paypal/1";
export const EXT_OFFER = "recourse-offer";
export const EXT_RECEIPT = "recourse-receipt";

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeHeader<T>(header: string, schema: z.ZodType<T>): T {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(header)) throw new Error("x402 header must be standard base64");
  return schema.parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
}

export const ResourceInfoSchema = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().max(32).optional(),
});

export const PaymentRequirementsSchema = z.object({
  scheme: z.string(),
  network: z.string().includes(":"),
  amount: z.string().regex(/^\d+$/),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.record(z.string(), z.unknown()),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

const extension = <T extends z.ZodTypeAny>(info: T) => z.object({ info, schema: z.record(z.string(), z.unknown()) });

export const OfferExtensionSchema = extension(z.object({ offer: SignedOfferSchema }));

export const PaymentRequiredSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: z.object({ [EXT_OFFER]: OfferExtensionSchema.optional() }).catchall(z.unknown()).optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

// What the agent signs. Binding the offer hash ties the payment to one publisher,
// one price and one content commitment; the publisher cannot reuse it elsewhere.
export const AgentAuthorizationSchema = z.object({
  v: z.literal(1),
  agentId: z.string(),
  offerId: z.string(),
  offerHash: z.string().regex(/^[0-9a-f]{64}$/),
  network: z.string(),
  asset: z.string(),
  amount: z.string().regex(/^\d+$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  validBefore: z.number().int(),
});
export type AgentAuthorization = z.infer<typeof AgentAuthorizationSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsSchema,
  payload: z.object({
    type: z.literal("authorize"),
    authorization: AgentAuthorizationSchema,
    kid: z.string(),
    signature: z.string(),
    // Added by the resource server before settle (x402 SDK: enrichSettlementPayload).
    delivery: SignedSchema(DeliveryBodySchema).optional(),
  }),
  extensions: z.object({ [EXT_OFFER]: OfferExtensionSchema.optional() }).catchall(z.unknown()).optional(),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

export const FacilitatorRequestSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type FacilitatorRequest = z.infer<typeof FacilitatorRequestSchema>;

export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  invalidMessage: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

export const SettlementResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
  amount: z.string().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>;

const OFFER_EXTENSION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { offer: { type: "object", required: ["body", "kid", "sig"] } },
  required: ["offer"],
};

export function buildPaymentRequired(offer: SignedOffer, network = NETWORK_SANDBOX): PaymentRequired {
  const o = OfferBodySchema.parse(offer.body);
  const refundDeadline = Math.floor(Date.parse(o.expiresAt) / 1000) + o.protectionWindowSec;
  return {
    x402Version: X402_VERSION,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url: o.resource, description: o.title, mimeType: o.mimeType },
    accepts: [
      {
        scheme: SCHEME,
        network,
        amount: String(o.price.minor),
        asset: o.price.currency,
        payTo: "merchant",
        maxTimeoutSeconds: 120,
        extra: { paymentFlow: "authorization", refundDeadline, offerId: o.offerId, binding: BINDING },
      },
    ],
    extensions: { [EXT_OFFER]: { info: { offer }, schema: OFFER_EXTENSION_SCHEMA } },
  };
}

export function offerFromPaymentRequired(pr: PaymentRequired): SignedOffer {
  const offer = pr.extensions?.[EXT_OFFER]?.info.offer;
  if (!offer) throw new Error(`402 response has no ${EXT_OFFER} extension`);
  return offer;
}

// Requirements and offer must say the same thing; an agent never pays for a
// requirement whose amount differs from the signed price.
export function requirementsMatchOffer(req: PaymentRequirements, offer: SignedOffer): boolean {
  const o = offer.body;
  return (
    req.scheme === SCHEME &&
    req.amount === String(o.price.minor) &&
    req.asset === o.price.currency &&
    req.extra["offerId"] === o.offerId
  );
}

export function authorizationMatches(auth: AgentAuthorization, req: PaymentRequirements, offer: SignedOffer): boolean {
  return (
    auth.offerId === offer.body.offerId &&
    auth.offerHash === offerHash(offer.body) &&
    auth.amount === req.amount &&
    auth.asset === req.asset &&
    auth.network === req.network
  );
}
