import { randomBytes } from "node:crypto";
import { sha256Hex, type Signer } from "@recourse/receipts";
import { offerHash, signBody, type SignedDelivery, type SignedOffer } from "./recourse";
import { X402_VERSION, EXT_OFFER, type PaymentPayload, type PaymentRequired, type PaymentRequirements } from "./x402";

export function newNonce(): string {
  return randomBytes(18).toString("base64url");
}

// Agent side: sign an authorization for exactly this offer and requirement.
export function buildPaymentPayload(input: {
  agentId: string;
  agentSigner: Signer;
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  offer: SignedOffer;
  nonce?: string;
  validForSec?: number;
  now?: Date;
}): PaymentPayload {
  const now = input.now ?? new Date();
  const authorization = {
    v: 1 as const,
    agentId: input.agentId,
    offerId: input.offer.body.offerId,
    offerHash: offerHash(input.offer.body),
    network: input.requirement.network,
    asset: input.requirement.asset,
    amount: input.requirement.amount,
    nonce: input.nonce ?? newNonce(),
    validBefore: Math.floor(now.getTime() / 1000) + (input.validForSec ?? 120),
  };
  return {
    x402Version: X402_VERSION,
    resource: input.paymentRequired.resource,
    accepted: input.requirement,
    payload: {
      type: "authorize",
      authorization,
      kid: input.agentSigner.kid,
      signature: input.agentSigner.sign(authorization),
    },
    // x402: the client echoes the server's extensions.
    extensions: { [EXT_OFFER]: input.paymentRequired.extensions![EXT_OFFER]! },
  };
}

// Publisher side: attest what was actually sent.
export function buildDelivery(signer: Signer, offerId: string, body: Uint8Array | string, now = new Date()): SignedDelivery {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return signBody(signer, {
    v: 1 as const,
    offerId,
    deliveredSha256: sha256Hex(bytes),
    deliveredLength: bytes.byteLength,
    deliveredAt: now.toISOString(),
  });
}
