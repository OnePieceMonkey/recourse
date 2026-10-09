import { describe, expect, it } from "vitest";
import { PaymentPayloadV2Schema, PaymentRequiredV2Schema, PaymentRequirementsV2Schema } from "@x402/core/schemas";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { generateSigner, sha256Hex } from "@recourse/receipts";
import {
  buildPaymentPayload,
  buildPaymentRequired,
  decodeHeader,
  encodeHeader,
  PaymentRequiredSchema,
  signBody,
  type OfferBody,
  type SettlementResponse,
} from "./index";

// Our wire objects checked against the official x402 TypeScript SDK (@x402/core),
// so "x402 V2 compatible" is a test result, not a claim.
const publisher = generateSigner("pub-interop").signer;
const agent = generateSigner("agent-interop").signer;
const body: OfferBody = {
  v: 1,
  offerId: "off_interop_0001",
  publisherId: "pub_interop",
  resource: "https://publisher.example/report",
  price: { currency: "EUR", minor: 490 },
  contentSha256: sha256Hex("report"),
  contentLength: 6,
  mimeType: "text/markdown",
  title: "Report",
  promise: "A complete report with all sections.",
  license: "read-and-cite",
  protectionWindowSec: 600,
  expiresAt: "2026-12-31T00:00:00.000Z",
};
const offer = signBody(publisher, body);
const pr = buildPaymentRequired(offer);
const payload = buildPaymentPayload({ agentId: "agt_1", agentSigner: agent, paymentRequired: pr, requirement: pr.accepts[0]!, offer });

describe("x402 V2 interop with @x402/core", () => {
  it("our PaymentRequired passes the official schema", () => {
    const r = PaymentRequiredV2Schema.safeParse(pr);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(PaymentRequirementsV2Schema.safeParse(pr.accepts[0]).success).toBe(true);
  });

  it("our PaymentPayload passes the official schema", () => {
    const r = PaymentPayloadV2Schema.safeParse(payload);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("headers round-trip between our codec and the official one", () => {
    expect(decodePaymentRequiredHeader(encodeHeader(pr))).toEqual(pr);
    expect(decodeHeader(encodePaymentRequiredHeader(pr as never), PaymentRequiredSchema)).toEqual(pr);
    expect(decodePaymentSignatureHeader(encodeHeader(payload))).toEqual(payload);
    const settlement: SettlementResponse = { success: true, transaction: "pur_1", network: "paypal:sandbox", payer: "agt_1", amount: "490" };
    expect(decodePaymentResponseHeader(encodeHeader(settlement))).toMatchObject(settlement);
  });

  it("uses the reserved extra keys the way the spec defines them", () => {
    expect(pr.accepts[0]!.extra).toMatchObject({ paymentFlow: "authorization" });
    expect(pr.accepts[0]!.network).toMatch(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/); // CAIP-2
  });
});
