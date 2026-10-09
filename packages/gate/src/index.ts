import { randomBytes } from "node:crypto";
import type { Context, Handler } from "hono";
import {
  buildDelivery,
  buildPaymentRequired,
  decodeHeader,
  encodeHeader,
  EXT_OFFER,
  FacilitatorRequestSchema,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HEADER_RECOURSE_DELIVERY,
  PaymentPayloadSchema,
  requirementsMatchOffer,
  SettlementResponseSchema,
  signBody,
  verifySigned,
  VerifyResponseSchema,
  X402_VERSION,
  type FacilitatorRequest,
  type MoneyT,
  type OfferBody,
  type SettlementResponse,
  type VerifyResponse,
} from "@recourse/protocol";
import { sha256Hex, type Signer } from "@recourse/receipts";

export interface Product {
  body: string | Uint8Array;
  title: string;
  promise: string; // what the buyer is promised; claims are judged against this
  price: MoneyT;
  mimeType: string;
  license?: string;
  protectionWindowSec?: number;
}

export interface FacilitatorClient {
  verify(req: FacilitatorRequest): Promise<VerifyResponse>;
  settle(req: FacilitatorRequest): Promise<SettlementResponse>;
}

export function httpFacilitator(baseUrl: string, fetchImpl: typeof fetch = fetch): FacilitatorClient {
  const post = async (path: string, body: unknown) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  };
  return {
    verify: async (req) => VerifyResponseSchema.parse(await post("/verify", req)),
    settle: async (req) => SettlementResponseSchema.parse(await post("/settle", req)),
  };
}

export interface GateConfig {
  publisherId: string;
  signer: Signer; // the publisher's key, registered with Recourse
  facilitator: FacilitatorClient;
  publicBaseUrl: string; // so offers name the URL agents actually see
  offerTtlSec?: number;
  protectionWindowSec?: number;
  network?: string;
}

// `phase` lets a publisher demo a bait-and-switch: what it offers and what it
// delivers come from two calls. An honest publisher returns the same bytes.
export type ProductResolver = (c: Context, phase: "offer" | "deliver") => Promise<Product | null> | Product | null;

const bytesOf = (b: string | Uint8Array) => (typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b));

export function paidRoute(cfg: GateConfig, resolve: ProductResolver): Handler {
  const resourceUrl = (c: Context) => `${cfg.publicBaseUrl.replace(/\/$/, "")}${new URL(c.req.url).pathname}`;

  const offerFor = (c: Context, p: Product) => {
    const bytes = bytesOf(p.body);
    const body: OfferBody = {
      v: 1,
      offerId: `off_${randomBytes(12).toString("base64url")}`,
      publisherId: cfg.publisherId,
      resource: resourceUrl(c),
      price: p.price,
      contentSha256: sha256Hex(bytes),
      contentLength: bytes.byteLength,
      mimeType: p.mimeType,
      title: p.title,
      promise: p.promise,
      license: p.license ?? "read-and-cite",
      protectionWindowSec: p.protectionWindowSec ?? cfg.protectionWindowSec ?? 86_400,
      expiresAt: new Date(Date.now() + (cfg.offerTtlSec ?? 300) * 1000).toISOString(),
    };
    return signBody(cfg.signer, body);
  };

  const paymentRequired = (c: Context, p: Product, error?: string) => {
    const pr = buildPaymentRequired(offerFor(c, p), cfg.network);
    if (error) pr.error = error;
    c.header(HEADER_PAYMENT_REQUIRED, encodeHeader(pr));
    return c.json({ ...pr, hint: "Pay with the x402 auth-capture scheme on PayPal. Details: https://github.com/OnePieceMonkey/recourse" }, 402);
  };

  return async (c) => {
    const header = c.req.header(HEADER_PAYMENT_SIGNATURE);
    if (!header) {
      const p = await resolve(c, "offer");
      return p ? paymentRequired(c, p) : c.notFound();
    }

    let payload;
    try {
      payload = decodeHeader(header, PaymentPayloadSchema);
    } catch (e) {
      return c.json({ error: "invalid_payload", message: (e as Error).message }, 400);
    }
    const offer = payload.extensions?.[EXT_OFFER]?.info.offer;
    // The gate only honours offers it signed itself, for this URL, still valid.
    if (
      !offer ||
      offer.body.publisherId !== cfg.publisherId ||
      offer.body.resource !== resourceUrl(c) ||
      !verifySigned(cfg.signer.publicJwk, offer) ||
      Date.parse(offer.body.expiresAt) < Date.now() ||
      !requirementsMatchOffer(payload.accepted, offer)
    ) {
      const p = await resolve(c, "offer");
      return p ? paymentRequired(c, p, "offer invalid or expired, here is a fresh one") : c.notFound();
    }

    const req = FacilitatorRequestSchema.parse({ x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: payload.accepted });
    const verified = await cfg.facilitator.verify(req);
    if (!verified.isValid) {
      return c.json({ error: verified.invalidReason, message: verified.invalidMessage }, 402);
    }

    // authorization flow: produce the content, attest it, then settle. If settle
    // fails, the content is not released.
    const product = await resolve(c, "deliver");
    if (!product) return c.notFound();
    const bytes = bytesOf(product.body);
    const delivery = buildDelivery(cfg.signer, offer.body.offerId, bytes);
    req.paymentPayload.payload.delivery = delivery;
    const settlement = await cfg.facilitator.settle(req);
    c.header(HEADER_PAYMENT_RESPONSE, encodeHeader(settlement));
    if (!settlement.success) {
      return c.json({ error: settlement.errorReason, message: settlement.errorMessage }, 402);
    }
    c.header(HEADER_RECOURSE_DELIVERY, encodeHeader(delivery));
    c.header("Content-Type", product.mimeType);
    return c.body(bytes, 200);
  };
}

export * from "./client";
