import { createHash, randomBytes } from "node:crypto";
import {
  adjudicate,
  checkMandate,
  DEFAULT_THRESHOLDS,
  refundAmountMinor,
  type ClaimThresholds,
  type Mandate,
  type ReasonCode,
  type Verdict,
} from "@recourse/policy";
import {
  authorizationMatches,
  ClaimRequestSchema,
  EXT_OFFER,
  EXT_RECEIPT,
  FacilitatorRequestSchema,
  NETWORK_SANDBOX,
  OfferBodySchema,
  offerHash,
  requirementsMatchOffer,
  SCHEME,
  verifySigned,
  type ClaimResult,
  type FacilitatorRequest,
  type OfferBody,
  type ReceiptData,
  type SettlementResponse,
  type SignedDelivery,
  type VerifyResponse,
} from "@recourse/protocol";
import type { PayPalApi } from "@recourse/paypal";
import {
  hashCanonical,
  makeEntry,
  noopAnchorer,
  sha256Hex,
  type Anchorer,
  type AnchorProof,
  type LogEntry,
  type LogEntryType,
  type PublicJwk,
  type Signer,
  verifySignature,
} from "@recourse/receipts";
import type { Db } from "./db";

// Independent second opinion for semantic claims. Implemented by packages/judge.
export type SecondOpinion = (input: {
  promise: string;
  title: string;
  mimeType: string;
  body: string;
  reasons: ReasonCode[];
}) => Promise<Verdict | undefined>;

export interface FacilitatorConfig {
  fundingThresholdMinor: number; // below: prepaid balance, at or above: PayPal vault charge
  thresholds: ClaimThresholds;
  maxClaimsPerAgentPerDay: number;
  publicBaseUrl: string;
  network: string;
}

export const DEFAULT_CONFIG: FacilitatorConfig = {
  fundingThresholdMinor: 100,
  thresholds: DEFAULT_THRESHOLDS,
  maxClaimsPerAgentPerDay: 20,
  publicBaseUrl: "http://localhost:4020",
  network: NETWORK_SANDBOX,
};

export class RecourseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function toRecourseError(e: unknown): RecourseError {
  if (e instanceof RecourseError) return e;
  if (e && typeof e === "object" && "issues" in e) return new RecourseError("invalid_payload", String((e as { message?: unknown }).message));
  return new RecourseError("unexpected_error", (e as Error)?.message ?? String(e), 500);
}

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (d: Date) => d.toISOString();
// Owner stats reach the public demo page, so never return a full payer address.
export const maskEmail = (e: string | null) => (e ? e.replace(/^(.)[^@]*(@.*)$/, "$1***$2") : null);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

interface PurchaseRow {
  id: string;
  owner_id: string;
  agent_id: string;
  publisher_id: string;
  offer_id: string;
  offer: OfferBody & { sig?: string };
  offer_hash: string;
  price_minor: number;
  currency: string;
  funding: "balance" | "paypal_vault";
  paypal_capture_id: string | null;
  refunded_minor: number;
  status: string;
  receipt_seq: number | null;
  delivery: SignedDelivery | null;
  protection_until: string | Date;
  created_at: string | Date;
}

export class Facilitator {
  constructor(
    readonly db: Db,
    readonly paypal: PayPalApi,
    readonly signer: Signer,
    readonly secondOpinion: SecondOpinion,
    readonly anchorer: Anchorer = noopAnchorer,
    readonly config: FacilitatorConfig = DEFAULT_CONFIG,
    readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- log ----------

  private async append(db: Db, type: LogEntryType, data: Record<string, unknown>): Promise<LogEntry> {
    const [head] = await db.query<{ entry: LogEntry }>("SELECT entry FROM log ORDER BY seq DESC LIMIT 1");
    const entry = makeEntry(head?.entry ?? null, type, data, this.signer, this.now());
    await db.query("INSERT INTO log (seq, hash, entry) VALUES ($1, $2, $3)", [entry.seq, entry.hash, entry]);
    return entry;
  }

  async logRange(fromSeq: number, toSeq: number): Promise<LogEntry[]> {
    const rows = await this.db.query<{ entry: LogEntry }>("SELECT entry FROM log WHERE seq BETWEEN $1 AND $2 ORDER BY seq", [
      fromSeq,
      toSeq,
    ]);
    return rows.map((r) => r.entry);
  }

  async logHead(): Promise<LogEntry | undefined> {
    const [row] = await this.db.query<{ entry: LogEntry }>("SELECT entry FROM log ORDER BY seq DESC LIMIT 1");
    return row?.entry;
  }

  publicKey(): { kid: string; jwk: PublicJwk } {
    return { kid: this.signer.kid, jwk: this.signer.publicJwk };
  }

  async anchorHead(): Promise<AnchorProof | undefined> {
    const head = await this.logHead();
    if (!head) return undefined;
    const [existing] = await this.db.query<{ proof: AnchorProof }>("SELECT proof FROM anchors WHERE head_seq = $1", [head.seq]);
    if (existing) return existing.proof;
    const proof = await this.anchorer.stamp(head.seq, head.hash);
    await this.db.query("INSERT INTO anchors (head_seq, head_hash, proof, updated_at) VALUES ($1, $2, $3, $4)", [
      head.seq,
      head.hash,
      proof,
      iso(this.now()),
    ]);
    return proof;
  }

  async upgradeAnchors(): Promise<number> {
    const rows = await this.db.query<{ head_seq: number; proof: AnchorProof }>(
      "SELECT head_seq, proof FROM anchors WHERE proof->>'status' = 'pending'",
    );
    let upgraded = 0;
    for (const r of rows) {
      const next = await this.anchorer.upgrade(r.proof);
      if (next.status !== r.proof.status) {
        await this.db.query("UPDATE anchors SET proof = $2, updated_at = $3 WHERE head_seq = $1", [r.head_seq, next, iso(this.now())]);
        upgraded += 1;
      }
    }
    return upgraded;
  }

  async anchors(): Promise<AnchorProof[]> {
    const rows = await this.db.query<{ proof: AnchorProof }>("SELECT proof FROM anchors ORDER BY head_seq");
    return rows.map((r) => r.proof);
  }

  // ---------- publishers ----------

  async registerPublisher(input: { id?: string; name: string; payoutEmail: string; kid: string; publicJwk: PublicJwk }) {
    const id = input.id ?? newId("pub");
    await this.db.query(
      `INSERT INTO publishers (id, name, payout_email, public_jwk, kid, created_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET name = $2, payout_email = $3, public_jwk = $4, kid = $5`,
      [id, input.name, input.payoutEmail, input.publicJwk, input.kid, iso(this.now())],
    );
    return { publisherId: id };
  }

  private async publisher(id: string, db: Db = this.db) {
    const [p] = await db.query<{ id: string; name: string; payout_email: string; public_jwk: PublicJwk; kid: string }>(
      "SELECT * FROM publishers WHERE id = $1",
      [id],
    );
    if (!p) throw new RecourseError("unknown_publisher", `publisher ${id} is not registered`, 404);
    return p;
  }

  // ---------- owners, vault, mandate, agents ----------

  async createOwner(name: string) {
    const id = newId("own");
    await this.db.query("INSERT INTO owners (id, name, created_at) VALUES ($1, $2, $3)", [id, name, iso(this.now())]);
    return { ownerId: id };
  }

  async startVaultSetup(ownerId: string, returnUrl: string, cancelUrl: string) {
    await this.owner(ownerId);
    const { setupTokenId, approveUrl } = await this.paypal.createVaultSetupToken({ returnUrl, cancelUrl });
    await this.db.query("INSERT INTO vault_setups (setup_token_id, owner_id, created_at) VALUES ($1, $2, $3)", [
      setupTokenId,
      ownerId,
      iso(this.now()),
    ]);
    return { setupTokenId, approveUrl };
  }

  async completeVaultSetup(setupTokenId: string) {
    const [row] = await this.db.query<{ owner_id: string }>("SELECT owner_id FROM vault_setups WHERE setup_token_id = $1", [
      setupTokenId,
    ]);
    if (!row) throw new RecourseError("unknown_setup_token", "unknown setup token", 404);
    const token = await this.paypal.createPaymentToken(setupTokenId);
    await this.db.query("UPDATE owners SET vault_id = $2, payer_email = $3 WHERE id = $1", [
      row.owner_id,
      token.vaultId,
      token.payerEmail ?? null,
    ]);
    return { ownerId: row.owner_id, vaultConnected: true, payerEmail: token.payerEmail };
  }

  async owner(ownerId: string, db: Db = this.db) {
    const [o] = await db.query<{ id: string; name: string; vault_id: string | null; payer_email: string | null }>(
      "SELECT id, name, vault_id, payer_email FROM owners WHERE id = $1",
      [ownerId],
    );
    if (!o) throw new RecourseError("unknown_owner", `owner ${ownerId} not found`, 404);
    return o;
  }

  async setMandate(ownerId: string, mandate: Omit<Mandate, "version">) {
    await this.owner(ownerId);
    const [last] = await this.db.query<{ version: number }>(
      "SELECT version FROM mandates WHERE owner_id = $1 ORDER BY version DESC LIMIT 1",
      [ownerId],
    );
    const body: Mandate = { ...mandate, version: (last?.version ?? 0) + 1 };
    const hash = hashCanonical(body);
    await this.db.query("INSERT INTO mandates (owner_id, version, body, hash, created_at) VALUES ($1, $2, $3, $4, $5)", [
      ownerId,
      body.version,
      body,
      hash,
      iso(this.now()),
    ]);
    return { mandate: body, hash };
  }

  async mandate(ownerId: string, db: Db = this.db): Promise<{ mandate: Mandate; hash: string }> {
    const [m] = await db.query<{ body: Mandate; hash: string }>(
      "SELECT body, hash FROM mandates WHERE owner_id = $1 ORDER BY version DESC LIMIT 1",
      [ownerId],
    );
    if (!m) throw new RecourseError("no_mandate", "owner has not set a mandate yet", 409);
    return { mandate: m.body, hash: m.hash };
  }

  // The agent signs payments with its own key (the publisher relays them, so a
  // bearer token there would leak); the token is only for talking to Recourse.
  async createAgent(ownerId: string, name: string, kid: string, publicJwk: PublicJwk) {
    await this.owner(ownerId);
    const id = newId("agt");
    const token = `rca_${randomBytes(24).toString("base64url")}`;
    await this.db.query(
      "INSERT INTO agents (id, owner_id, name, token_hash, kid, public_jwk, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, ownerId, name, tokenHash(token), kid, publicJwk, iso(this.now())],
    );
    return { agentId: id, token };
  }

  private async agentById(agentId: string, db: Db = this.db) {
    const [a] = await db.query<{ id: string; owner_id: string; kid: string; public_jwk: PublicJwk }>(
      "SELECT id, owner_id, kid, public_jwk FROM agents WHERE id = $1",
      [agentId],
    );
    return a;
  }

  async authenticateAgent(token: string | undefined) {
    if (!token) throw new RecourseError("unauthorized", "missing agent token", 401);
    const [a] = await this.db.query<{ id: string; owner_id: string; name: string }>(
      "SELECT id, owner_id, name FROM agents WHERE token_hash = $1",
      [tokenHash(token)],
    );
    if (!a) throw new RecourseError("unauthorized", "invalid agent token", 401);
    return { agentId: a.id, ownerId: a.owner_id, name: a.name };
  }

  // ---------- prepaid balance ----------

  async balance(ownerId: string, db: Db = this.db) {
    const [r] = await db.query<{ total: number | null }>("SELECT SUM(amount_minor)::int AS total FROM ledger WHERE owner_id = $1", [
      ownerId,
    ]);
    return Number(r?.total ?? 0);
  }

  async startTopup(ownerId: string, amountMinor: number, currency: string, returnUrl: string, cancelUrl: string) {
    await this.owner(ownerId);
    if (amountMinor < 100 || amountMinor > 10000) throw new RecourseError("invalid_amount", "top-ups are between 1 and 100", 400);
    const requestId = newId("req");
    const { orderId, approveUrl } = await this.paypal.createTopupOrder({
      amount: { currency, minor: amountMinor },
      customId: `topup:${ownerId}`,
      returnUrl,
      cancelUrl,
      requestId,
    });
    await this.db.query(
      "INSERT INTO topups (order_id, owner_id, amount_minor, currency, status, created_at) VALUES ($1, $2, $3, $4, 'CREATED', $5)",
      [orderId, ownerId, amountMinor, currency, iso(this.now())],
    );
    return { orderId, approveUrl };
  }

  async completeTopup(orderId: string) {
    const [t] = await this.db.query<{ owner_id: string; status: string; currency: string }>(
      "SELECT owner_id, status, currency FROM topups WHERE order_id = $1",
      [orderId],
    );
    if (!t) throw new RecourseError("unknown_order", "unknown top-up order", 404);
    if (t.status === "COMPLETED") return { ownerId: t.owner_id, balanceMinor: await this.balance(t.owner_id) };
    const cap = await this.paypal.captureOrder(orderId, `capture:${orderId}`);
    await this.db.tx(async (db) => {
      await db.query("UPDATE topups SET status = 'COMPLETED', capture_id = $2 WHERE order_id = $1", [orderId, cap.captureId]);
      await db.query(
        "INSERT INTO ledger (id, owner_id, kind, amount_minor, currency, ref, created_at) VALUES ($1, $2, 'topup', $3, $4, $5, $6)",
        [newId("led"), t.owner_id, cap.amount.minor, cap.amount.currency, cap.captureId, iso(this.now())],
      );
    });
    return { ownerId: t.owner_id, balanceMinor: await this.balance(t.owner_id) };
  }

  // ---------- settle ----------

  async spentThisMonth(ownerId: string, db: Db = this.db) {
    const [r] = await db.query<{ total: number | null }>(
      "SELECT SUM(price_minor - refunded_minor)::int AS total FROM purchases WHERE owner_id = $1 AND created_at >= $2",
      [ownerId, iso(monthStart(this.now()))],
    );
    return Number(r?.total ?? 0);
  }

  // x402 /verify: read-only. Everything that can fail before content is produced.
  async verifyPayment(raw: unknown): Promise<VerifyResponse> {
    try {
      const ctx = await this.checkPayment(FacilitatorRequestSchema.parse(raw), this.db, false);
      return { isValid: true, payer: ctx.agent.id };
    } catch (e) {
      const err = toRecourseError(e);
      return { isValid: false, invalidReason: err.code, invalidMessage: err.message };
    }
  }

  private async checkPayment(req: FacilitatorRequest, db: Db, consumeNonce: boolean) {
    const { paymentPayload: pp, paymentRequirements: reqs } = req;
    if (reqs.scheme !== SCHEME) throw new RecourseError("unsupported_scheme", `scheme ${reqs.scheme} is not supported`);
    if (reqs.network !== this.config.network) throw new RecourseError("invalid_network", `network must be ${this.config.network}`);
    const offerSigned = pp.extensions?.[EXT_OFFER]?.info.offer;
    if (!offerSigned) throw new RecourseError("invalid_payload", `missing ${EXT_OFFER} extension`);
    const offer = OfferBodySchema.parse(offerSigned.body);
    const pub = await this.publisher(offer.publisherId, db);
    if (!verifySigned(pub.public_jwk, offerSigned)) throw new RecourseError("invalid_offer_signature", "offer signature does not verify");
    if (!requirementsMatchOffer(reqs, offerSigned) || !requirementsMatchOffer(pp.accepted, offerSigned)) {
      throw new RecourseError("invalid_payment_requirements", "requirements do not match the signed offer");
    }
    const auth = pp.payload.authorization;
    if (!authorizationMatches(auth, reqs, offerSigned)) throw new RecourseError("invalid_payload", "authorization does not match the offer");
    const agent = await this.agentById(auth.agentId, db);
    if (!agent || agent.kid !== pp.payload.kid || !verifySignature(agent.public_jwk, auth, pp.payload.signature)) {
      throw new RecourseError("invalid_agent_signature", "agent signature does not verify");
    }
    const now = this.now();
    if (new Date(offer.expiresAt) < now) throw new RecourseError("offer_expired", "offer expired");
    if (auth.validBefore * 1000 < now.getTime()) throw new RecourseError("authorization_expired", "authorization expired");

    const [used] = await db.query("SELECT nonce FROM nonces WHERE nonce = $1", [auth.nonce]);
    if (used) throw new RecourseError("replayed_nonce", "nonce already used", 409);
    const [dup] = await db.query("SELECT id FROM purchases WHERE offer_id = $1", [offer.offerId]);
    if (dup) throw new RecourseError("offer_already_paid", "this offer was already paid", 409);
    if (consumeNonce) await db.query("INSERT INTO nonces (nonce, created_at) VALUES ($1, $2)", [auth.nonce, iso(now)]);

    const owner = await this.owner(agent.owner_id, db);
    const { mandate, hash: mandateHash } = await this.mandate(agent.owner_id, db);
    const decision = checkMandate(
      { publisherId: offer.publisherId, priceMinor: offer.price.minor, currency: offer.price.currency },
      mandate,
      { spentThisMonthMinor: await this.spentThisMonth(agent.owner_id, db) },
    );
    if (!decision.allow) {
      throw new RecourseError("mandate_violation", `purchase outside mandate: ${decision.reasons.join(", ")}`, 403);
    }
    const funding: "balance" | "paypal_vault" = offer.price.minor < this.config.fundingThresholdMinor ? "balance" : "paypal_vault";
    if (funding === "balance" && (await this.balance(agent.owner_id, db)) < offer.price.minor) {
      throw new RecourseError("insufficient_funds", "prepaid balance too low, top up first", 402);
    }
    if (funding === "paypal_vault" && !owner.vault_id) throw new RecourseError("insufficient_funds", "owner has not connected PayPal", 402);
    return { offer, offerSigned, pub, agent, owner, mandate, mandateHash, funding, auth };
  }

  // x402 /settle under the `authorization` flow: the gate has produced the content
  // and sends the publisher-signed delivery attestation with the settle call.
  // Money moves only if what was delivered is what was committed.
  async settlePayment(raw: unknown): Promise<SettlementResponse & { purchaseId?: string }> {
    const network = this.config.network;
    let req: FacilitatorRequest;
    try {
      req = FacilitatorRequestSchema.parse(raw);
    } catch (e) {
      return { success: false, errorReason: "invalid_payload", errorMessage: (e as Error).message, transaction: "", network };
    }
    const purchaseId = newId("pur");
    const now = this.now();
    let ctx: Awaited<ReturnType<Facilitator["checkPayment"]>>;
    try {
      ctx = await this.db.tx(async (db) => {
        const c = await this.checkPayment(req, db, true);
        const delivery = req.paymentPayload.payload.delivery;
        if (!delivery || delivery.body.offerId !== c.offer.offerId || !verifySigned(c.pub.public_jwk, delivery)) {
          throw new RecourseError("invalid_delivery_attestation", "settle needs a publisher-signed delivery attestation");
        }
        if (delivery.body.deliveredSha256 !== c.offer.contentSha256) {
          throw new RecourseError("delivery_mismatch", "delivered content differs from the signed commitment; nothing was charged");
        }
        if (c.funding === "balance") {
          await db.query(
            "INSERT INTO ledger (id, owner_id, kind, amount_minor, currency, ref, created_at) VALUES ($1, $2, 'purchase', $3, $4, $5, $6)",
            [newId("led"), c.agent.owner_id, -c.offer.price.minor, c.offer.price.currency, purchaseId, iso(now)],
          );
        }
        return c;
      });
    } catch (e) {
      const err = toRecourseError(e);
      if (err.code === "delivery_mismatch") await this.recordRefusal(req, err);
      return { success: false, errorReason: err.code, errorMessage: err.message, transaction: "", network };
    }

    const { offer, offerSigned, agent, owner, funding } = ctx;
    const delivery = req.paymentPayload.payload.delivery!;
    let capture: { orderId: string; captureId: string } | undefined;
    if (funding === "paypal_vault") {
      try {
        capture = await this.paypal.chargeVault({
          vaultId: owner.vault_id!,
          amount: offer.price,
          description: offer.title.slice(0, 127),
          customId: purchaseId,
          requestId: `charge:${purchaseId}`,
        });
      } catch (e) {
        await this.db.query("DELETE FROM nonces WHERE nonce = $1", [ctx.auth.nonce]);
        return { success: false, errorReason: "paypal_charge_failed", errorMessage: (e as Error).message, transaction: "", network };
      }
    }

    const protectionUntil = new Date(now.getTime() + offer.protectionWindowSec * 1000);
    const receipt = await this.db.tx(async (db) => {
      const receiptData: ReceiptData = {
        purchaseId,
        offerId: offer.offerId,
        offerHash: offerHash(offer),
        offerSig: offerSigned.sig,
        publisherId: offer.publisherId,
        ownerId: agent.owner_id,
        agentId: agent.id,
        price: offer.price,
        funding,
        ...(capture ? { paypalCaptureId: capture.captureId } : {}),
        mandateVersion: ctx.mandate.version,
        mandateHash: ctx.mandateHash,
        deliveredSha256: delivery.body.deliveredSha256,
        deliveredLength: delivery.body.deliveredLength,
        protectionUntil: iso(protectionUntil),
      };
      const entry = await this.append(db, "receipt", receiptData as unknown as Record<string, unknown>);
      await db.query(
        `INSERT INTO purchases (id, owner_id, agent_id, publisher_id, offer_id, offer, offer_hash, price_minor, currency, funding,
           paypal_order_id, paypal_capture_id, status, receipt_seq, delivery, protection_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'SETTLED',$13,$14,$15,$16)`,
        [
          purchaseId,
          agent.owner_id,
          agent.id,
          offer.publisherId,
          offer.offerId,
          { ...offer, sig: offerSigned.sig },
          receiptData.offerHash,
          offer.price.minor,
          offer.price.currency,
          funding,
          capture?.orderId ?? null,
          capture?.captureId ?? null,
          entry.seq,
          delivery,
          iso(protectionUntil),
          iso(now),
        ],
      );
      await db.query(
        `INSERT INTO earnings (purchase_id, publisher_id, amount_minor, currency, status, payable_after)
         VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
        [purchaseId, offer.publisherId, offer.price.minor, offer.price.currency, iso(protectionUntil)],
      );
      return entry;
    });

    return {
      success: true,
      transaction: purchaseId,
      network,
      payer: agent.id,
      amount: String(offer.price.minor),
      purchaseId,
      extensions: {
        [EXT_RECEIPT]: {
          info: {
            purchaseId,
            funding,
            ...(capture ? { paypalCaptureId: capture.captureId } : {}),
            receipt,
            recoursePublicKey: this.publicKey(),
            claimUrl: `${this.config.publicBaseUrl}/v1/claims`,
            verifyUrl: `${this.config.publicBaseUrl}/v1/log/${receipt.seq}`,
          },
          schema: { type: "object" },
        },
      },
    };
  }

  // A refused bait-and-switch is evidence too: it lands in the log and on the
  // publisher's record, even though no money moved.
  private async recordRefusal(req: FacilitatorRequest, err: RecourseError) {
    const offer = req.paymentPayload.extensions?.[EXT_OFFER]?.info.offer?.body;
    await this.db.tx((db) =>
      this.append(db, "settlement_refused", {
        reason: err.code,
        offerId: offer?.offerId ?? null,
        publisherId: offer?.publisherId ?? null,
        agentId: req.paymentPayload.payload.authorization.agentId,
        committedSha256: offer?.contentSha256 ?? null,
        deliveredSha256: req.paymentPayload.payload.delivery?.body.deliveredSha256 ?? null,
      }),
    );
  }

  async purchase(id: string): Promise<PurchaseRow> {
    const [p] = await this.db.query<PurchaseRow>("SELECT * FROM purchases WHERE id = $1", [id]);
    if (!p) throw new RecourseError("unknown_purchase", `purchase ${id} not found`, 404);
    return { ...p, price_minor: Number(p.price_minor), refunded_minor: Number(p.refunded_minor) };
  }

  // ---------- claims ----------

  async fileClaim(agentToken: string | undefined, raw: unknown): Promise<ClaimResult> {
    const agent = await this.authenticateAgent(agentToken);
    const req = ClaimRequestSchema.parse(raw);
    const p = await this.purchase(req.purchaseId);
    if (p.owner_id !== agent.ownerId) throw new RecourseError("forbidden", "purchase belongs to another owner", 403);
    const [prior] = await this.db.query("SELECT id FROM claims WHERE purchase_id = $1 AND outcome <> 'REJECT'", [p.id]);
    if (prior) throw new RecourseError("claim_exists", "an open or granted claim exists for this purchase", 409);
    const [count] = await this.db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM claims WHERE agent_id = $1 AND created_at >= $2",
      [agent.agentId, iso(new Date(this.now().getTime() - 86_400_000))],
    );
    if (Number(count?.n ?? 0) >= this.config.maxClaimsPerAgentPerDay) {
      throw new RecourseError("claim_rate_limited", "too many claims today", 429);
    }

    const body = Buffer.from(req.bodyBase64, "base64");
    const submittedSha256 = sha256Hex(body);

    // Prefer the attestation the gate recorded; fall back to the one the agent sends.
    const pub = await this.publisher(p.publisher_id);
    const delivery = [p.delivery, req.delivery].find(
      (d): d is SignedDelivery =>
        !!d && d.body.offerId === p.offer_id && verifySigned(pub.public_jwk, d),
    );

    const offer = p.offer;
    const withinProtectionWindow = this.now() <= new Date(p.protection_until);
    const semantic = req.reasons.some((r) => r !== "HASH_MISMATCH");
    const ownVerdict =
      semantic && submittedSha256 === offer.contentSha256
        ? await this.secondOpinion({
            promise: offer.promise,
            title: offer.title,
            mimeType: offer.mimeType,
            body: body.toString("utf8"),
            reasons: req.reasons,
          })
        : undefined;

    const decision = adjudicate(
      {
        reasons: req.reasons,
        refundBps: req.refundBps,
        committedSha256: offer.contentSha256,
        ...(delivery ? { deliveredSha256: delivery.body.deliveredSha256 } : {}),
        submittedSha256,
        withinProtectionWindow,
      },
      ownVerdict,
      this.config.thresholds,
    );

    const refundMinor =
      decision.outcome === "REFUND" ? Math.min(refundAmountMinor(p.price_minor, decision.refundBps), p.price_minor - p.refunded_minor) : 0;

    let paypalRefundId: string | undefined;
    const claimId = newId("clm");
    // Every refund is a real PayPal refund the owner can see in PayPal: vault
    // purchases refund their own capture, balance purchases refund part of the
    // top-up capture that funded the balance. Ledger credit is only the fallback.
    let topupRefunded: string | undefined;
    if (refundMinor > 0) {
      const note = `Recourse claim ${claimId}: ${decision.reasons.join(", ")}`.slice(0, 255);
      const amount = { currency: p.currency, minor: refundMinor };
      if (p.funding === "paypal_vault") {
        paypalRefundId = (await this.paypal.refundCapture({ captureId: p.paypal_capture_id!, amount, note, requestId: `refund:${claimId}` })).refundId;
      } else {
        const [topup] = await this.db.query<{ order_id: string; capture_id: string }>(
          `SELECT order_id, capture_id FROM topups WHERE owner_id = $1 AND status = 'COMPLETED' AND currency = $2
             AND amount_minor - refunded_minor >= $3 ORDER BY created_at DESC LIMIT 1`,
          [p.owner_id, p.currency, refundMinor],
        );
        if (topup) {
          paypalRefundId = (await this.paypal.refundCapture({ captureId: topup.capture_id, amount, note, requestId: `refund:${claimId}` })).refundId;
          topupRefunded = topup.order_id;
        }
      }
    }

    const entry = await this.db.tx(async (db) => {
      if (refundMinor > 0) {
        if (topupRefunded) {
          await db.query("UPDATE topups SET refunded_minor = refunded_minor + $2 WHERE order_id = $1", [topupRefunded, refundMinor]);
        } else if (p.funding === "balance") {
          await db.query(
            "INSERT INTO ledger (id, owner_id, kind, amount_minor, currency, ref, created_at) VALUES ($1, $2, 'refund', $3, $4, $5, $6)",
            [newId("led"), p.owner_id, refundMinor, p.currency, claimId, iso(this.now())],
          );
        }
        const refunded = p.refunded_minor + refundMinor;
        await db.query("UPDATE purchases SET refunded_minor = $2, status = $3 WHERE id = $1", [
          p.id,
          refunded,
          refunded >= p.price_minor ? "REFUNDED" : "PARTIALLY_REFUNDED",
        ]);
        await db.query(
          `UPDATE earnings SET amount_minor = amount_minor - $2,
             status = CASE WHEN amount_minor - $2 <= 0 THEN 'CANCELLED' ELSE status END
           WHERE purchase_id = $1`,
          [p.id, refundMinor],
        );
      }
      const logEntry = await this.append(db, "claim_decision", {
        claimId,
        purchaseId: p.id,
        receiptSeq: p.receipt_seq,
        claimed: req.reasons,
        outcome: decision.outcome,
        decided: decision.reasons,
        refund: { currency: p.currency, minor: refundMinor },
        submittedSha256,
        committedSha256: offer.contentSha256,
        deliveredSha256: delivery?.body.deliveredSha256 ?? null,
        agentVerdict: req.agentVerdict ?? null,
        ownVerdict: ownVerdict ?? null,
        policyVersion: req.policyVersion,
        ...(paypalRefundId ? { paypalRefundId } : {}),
      });
      await db.query(
        `INSERT INTO claims (id, purchase_id, agent_id, reasons, requested_bps, outcome, refund_minor, decided_reasons,
           agent_verdict, own_verdict, paypal_refund_id, log_seq, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          claimId,
          p.id,
          agent.agentId,
          JSON.stringify(req.reasons),
          req.refundBps,
          decision.outcome,
          refundMinor,
          JSON.stringify(decision.reasons),
          req.agentVerdict ?? null,
          ownVerdict ?? null,
          paypalRefundId ?? null,
          logEntry.seq,
          iso(this.now()),
        ],
      );
      return logEntry;
    });

    return {
      claimId,
      purchaseId: p.id,
      outcome: decision.outcome,
      refundBps: decision.refundBps,
      refund: { currency: p.currency, minor: refundMinor },
      reasons: decision.reasons,
      logSeq: entry.seq,
      ...(paypalRefundId ? { paypalRefundId } : {}),
    };
  }

  // ---------- payouts ----------

  async runPayouts() {
    const due = await this.db.query<{ purchase_id: string; publisher_id: string; amount_minor: number; currency: string; payout_email: string }>(
      `SELECT e.purchase_id, e.publisher_id, e.amount_minor, e.currency, p.payout_email
       FROM earnings e JOIN publishers p ON p.id = e.publisher_id
       WHERE e.status = 'PENDING' AND e.payable_after <= $1 AND e.amount_minor > 0`,
      [iso(this.now())],
    );
    if (!due.length) return { payoutId: undefined, items: 0 };
    const byPublisher = new Map<string, { email: string; currency: string; minor: number; purchases: string[] }>();
    for (const d of due) {
      const k = `${d.publisher_id}:${d.currency}`;
      const cur = byPublisher.get(k) ?? { email: d.payout_email, currency: d.currency, minor: 0, purchases: [] };
      cur.minor += Number(d.amount_minor);
      cur.purchases.push(d.purchase_id);
      byPublisher.set(k, cur);
    }
    const payoutId = newId("pay");
    const items = [...byPublisher.entries()].map(([k, v]) => ({
      receiverEmail: v.email,
      amount: { currency: v.currency, minor: v.minor },
      note: `Recourse earnings, ${v.purchases.length} purchase(s)`,
      senderItemId: `${payoutId}:${k.split(":")[0]}`,
    }));
    const res = await this.paypal.createPayout({ senderBatchId: payoutId, emailSubject: "Your Recourse earnings", items });
    const total = items.reduce((s, i) => s + i.amount.minor, 0);
    await this.db.tx(async (db) => {
      const entry = await this.append(db, "payout", {
        payoutId,
        paypalBatchId: res.payoutBatchId,
        items: items.map((i) => ({ publisher: i.senderItemId.split(":")[1], amount: i.amount })),
      });
      await db.query("INSERT INTO payouts (id, paypal_batch_id, status, total_minor, currency, log_seq, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        payoutId,
        res.payoutBatchId,
        res.status,
        total,
        items[0]!.amount.currency,
        entry.seq,
        iso(this.now()),
      ]);
      for (const d of due) {
        await db.query("UPDATE earnings SET status = 'PAID', payout_batch_id = $2 WHERE purchase_id = $1", [d.purchase_id, payoutId]);
      }
    });
    return { payoutId, paypalBatchId: res.payoutBatchId, items: items.length, totalMinor: total };
  }

  // ---------- PayPal disputes ----------

  // When an owner goes to PayPal instead of filing a Recourse claim, Recourse is
  // the merchant in that case and answers with the same evidence its own
  // adjudication used: the signed offer, the delivery attestation, the receipt.
  async answerDisputes() {
    const open = await this.paypal.listDisputes("REQUIRED_ACTION");
    const answered: { disputeId: string; action: string; purchaseId?: string }[] = [];
    for (const d of open) {
      const [seen] = await this.db.query("SELECT dispute_id FROM disputes WHERE dispute_id = $1", [d.disputeId]);
      if (seen) continue;
      const detail = await this.paypal.getDispute(d.disputeId);
      const [p] = detail.captureIds.length
        ? await this.db.query<PurchaseRow>("SELECT * FROM purchases WHERE paypal_capture_id = ANY($1::text[])", [detail.captureIds])
        : [];
      let action: "evidence" | "accepted" | "unknown_transaction";
      if (!p) {
        action = "unknown_transaction";
      } else {
        const purchase = { ...p, price_minor: Number(p.price_minor), refunded_minor: Number(p.refunded_minor) };
        const [claim] = await this.db.query<{ id: string; outcome: string; decided_reasons: string[]; paypal_refund_id: string | null; log_seq: number }>(
          "SELECT id, outcome, decided_reasons, paypal_refund_id, log_seq FROM claims WHERE purchase_id = $1 ORDER BY created_at DESC LIMIT 1",
          [purchase.id],
        );
        const delivered = purchase.delivery?.body.deliveredSha256;
        if (delivered && delivered !== purchase.offer.contentSha256 && purchase.refunded_minor < purchase.price_minor) {
          // Our own evidence says the buyer is right: accept instead of arguing.
          await this.paypal.acceptDisputeClaim(d.disputeId, `Recourse_${purchase.id}_delivery_mismatch`);
          action = "accepted";
        } else {
          await this.paypal.provideDisputeEvidence(d.disputeId, this.evidenceNotes(purchase, claim));
          action = "evidence";
        }
      }
      const entry = await this.db.tx(async (db) => {
        const e = await this.append(db, "dispute_response", {
          disputeId: d.disputeId,
          reason: d.reason,
          purchaseId: p?.id ?? null,
          receiptSeq: p?.receipt_seq ?? null,
          action,
        });
        await db.query("INSERT INTO disputes (dispute_id, purchase_id, reason, action, log_seq, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [
          d.disputeId,
          p?.id ?? null,
          d.reason,
          action,
          e.seq,
          iso(this.now()),
        ]);
        return e;
      });
      answered.push({ disputeId: d.disputeId, action, ...(p ? { purchaseId: p.id } : {}), logSeq: entry.seq } as never);
    }
    return { answered };
  }

  private evidenceNotes(p: PurchaseRow, claim?: { id: string; outcome: string; decided_reasons: string[]; paypal_refund_id: string | null; log_seq: number }) {
    const o = p.offer;
    const d = p.delivery?.body;
    const lines = [
      `Recourse delivery evidence for purchase ${p.id} (digital content, x402 auth-capture on PayPal).`,
      `Offer ${o.offerId} by publisher ${o.publisherId}, signed (Ed25519): "${o.title}". Promise: "${o.promise}".`,
      `Committed SHA-256 of the content: ${o.contentSha256} (${o.contentLength} bytes).`,
      d
        ? `Publisher-signed delivery attestation at ${d.deliveredAt}: SHA-256 ${d.deliveredSha256} (${d.deliveredLength} bytes), ${d.deliveredSha256 === o.contentSha256 ? "identical to the commitment" : "DIFFERENT from the commitment"}.`
        : "No delivery attestation on record.",
      `Receipt: transparency log entry #${p.receipt_seq}, verifiable at ${this.config.publicBaseUrl}/v1/log/${p.receipt_seq} with key ${this.signer.kid} (${this.config.publicBaseUrl}/.well-known/recourse.json).`,
      claim
        ? `Recourse claim ${claim.id}: ${claim.outcome} (${claim.decided_reasons.join(", ")})${claim.paypal_refund_id ? `, PayPal refund ${claim.paypal_refund_id}` : ""}, log entry #${claim.log_seq}.`
        : "The buyer's agent filed no claim with Recourse during the protection window.",
      p.refunded_minor > 0 ? `Already refunded: ${p.refunded_minor} of ${p.price_minor} minor units ${p.currency}.` : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  // ---------- read models for the dashboard ----------

  async publisherStats(publisherId: string) {
    await this.publisher(publisherId);
    const purchases = await this.db.query(
      `SELECT p.id, p.offer->>'title' AS title, p.price_minor, p.currency, p.funding, p.status, p.refunded_minor, p.created_at,
              e.status AS earning_status, e.amount_minor AS earning_minor, c.outcome AS claim_outcome, c.decided_reasons
       FROM purchases p JOIN earnings e ON e.purchase_id = p.id
       LEFT JOIN claims c ON c.purchase_id = p.id
       WHERE p.publisher_id = $1 ORDER BY p.created_at DESC`,
      [publisherId],
    );
    return { publisherId, purchases };
  }

  async ownerStats(ownerId: string) {
    const owner = await this.owner(ownerId);
    const purchases = await this.db.query(
      `SELECT p.id, p.publisher_id, p.offer->>'title' AS title, p.price_minor, p.currency, p.funding, p.status, p.refunded_minor,
              p.receipt_seq, p.created_at, c.outcome AS claim_outcome, c.decided_reasons, c.paypal_refund_id
       FROM purchases p LEFT JOIN claims c ON c.purchase_id = p.id
       WHERE p.owner_id = $1 ORDER BY p.created_at DESC`,
      [ownerId],
    );
    return {
      owner: { id: owner.id, name: owner.name, paypalConnected: !!owner.vault_id, payerEmail: maskEmail(owner.payer_email) },
      balanceMinor: await this.balance(ownerId),
      spentThisMonthMinor: await this.spentThisMonth(ownerId),
      mandate: (await this.mandate(ownerId).catch(() => undefined))?.mandate,
      purchases,
    };
  }
}
