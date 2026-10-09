import { randomUUID } from "node:crypto";
import { fromPayPalValue, toPayPalAmount, toPayPalValue, type Money } from "./money";
import { PayPalError, type DisputeSummary, type PayPalApi } from "./types";

const SANDBOX = "https://api-m.sandbox.paypal.com";

export interface PayPalRestConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string; // sandbox only; live is refused on purpose
  brandName?: string;
  locale?: string;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, any>;

// Thin client over the PayPal REST APIs Recourse needs. Plain fetch, no SDK:
// every call is visible, idempotency keys are explicit, amounts never touch floats.
export class PayPalRest implements PayPalApi {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number; scope: string } | undefined;
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: PayPalRestConfig) {
    this.base = cfg.baseUrl ?? SANDBOX;
    if (!this.base.includes("sandbox")) throw new Error("Recourse only talks to the PayPal sandbox");
    this.f = cfg.fetchImpl ?? fetch;
  }

  // ---------- plumbing ----------

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await this.f(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new PayPalError(`oauth failed: ${body.error_description ?? res.status}`, res.status, body.error, undefined, body);
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000, scope: body.scope ?? "" };
    return this.token.value;
  }

  // The token scope tells us which features the sandbox app has enabled.
  async scopes(): Promise<string[]> {
    await this.accessToken();
    return (this.token?.scope ?? "").split(" ").filter(Boolean);
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, opts: { requestId?: string; headers?: Record<string, string> } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}),
      ...opts.headers,
    };
    const res = await this.f(`${this.base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) {
      const detail = json.details?.[0];
      throw new PayPalError(
        `${method} ${path} -> ${res.status} ${json.name ?? ""}${detail ? ` (${detail.issue}: ${detail.description})` : json.message ? ` ${json.message}` : ""}`,
        res.status,
        detail?.issue ?? json.name,
        json.debug_id,
        json,
      );
    }
    return json as T;
  }

  private async multipart<T = Json>(path: string, input: unknown, files: { name: string; filename: string; type: string; data: Uint8Array }[] = []) {
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
    for (const f of files) form.append(f.name, new Blob([Buffer.from(f.data)], { type: f.type }), f.filename);
    const res = await this.f(`${this.base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${await this.accessToken()}` }, body: form });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) throw new PayPalError(`POST ${path} -> ${res.status} ${json.name ?? ""}`, res.status, json.details?.[0]?.issue ?? json.name, json.debug_id, json);
    return json as T;
  }

  private static link(json: Json, ...rels: string[]): string {
    const l = (json.links as { rel: string; href: string }[] | undefined)?.find((x) => rels.includes(x.rel));
    if (!l) throw new PayPalError(`no ${rels.join("/")} link in response`, 500, "MISSING_LINK", json.debug_id, json);
    return l.href;
  }

  private experience(returnUrl: string, cancelUrl: string, extra: Json = {}) {
    return {
      brand_name: this.cfg.brandName ?? "Recourse",
      locale: this.cfg.locale ?? "de-DE",
      shipping_preference: "NO_SHIPPING",
      return_url: returnUrl,
      cancel_url: cancelUrl,
      ...extra,
    };
  }

  // ---------- vault (owner connects PayPal once) ----------

  async createVaultSetupToken(input: { returnUrl: string; cancelUrl: string; description?: string; customerId?: string }) {
    const json = await this.call(
      "POST",
      "/v3/vault/setup-tokens",
      {
        ...(input.customerId ? { customer: { merchant_customer_id: input.customerId } } : {}),
        payment_source: {
          paypal: {
            description: input.description ?? "Recourse: your AI agent may buy digital content within the limits you set.",
            usage_pattern: "UNSCHEDULED_PREPAID",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: this.experience(input.returnUrl, input.cancelUrl),
          },
        },
      },
      { requestId: randomUUID() },
    );
    return { setupTokenId: json.id as string, approveUrl: PayPalRest.link(json, "approve") };
  }

  async createPaymentToken(setupTokenId: string) {
    const json = await this.call(
      "POST",
      "/v3/vault/payment-tokens",
      { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
      { requestId: `pt-${setupTokenId}` },
    );
    return {
      vaultId: json.id as string,
      payerEmail: json.payment_source?.paypal?.email_address as string | undefined,
      payerId: json.payment_source?.paypal?.payer_id as string | undefined,
    };
  }

  // ---------- charges ----------

  async chargeVault(input: { vaultId: string; amount: Money; description: string; customId: string; requestId: string; url?: string }) {
    const value = toPayPalValue(input.amount.minor);
    const amount = { currency_code: input.amount.currency, value };
    const json = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.customId,
            custom_id: input.customId,
            description: input.description.slice(0, 127),
            amount: { ...amount, breakdown: { item_total: amount } },
            items: [
              {
                name: input.description.slice(0, 127),
                quantity: "1",
                category: "DIGITAL_GOODS",
                unit_amount: amount,
                ...(input.url ? { url: input.url } : {}),
              },
            ],
          },
        ],
        payment_source: {
          paypal: {
            vault_id: input.vaultId,
            stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_PREPAID" },
          },
        },
      },
      { requestId: input.requestId },
    );
    // Vault charges normally complete in the create call; capture only if they did not.
    const order = json.status === "COMPLETED" ? json : await this.call("POST", `/v2/checkout/orders/${json.id}/capture`, {}, { requestId: `${input.requestId}-cap` });
    const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) throw new PayPalError(`order ${json.id} has no capture (status ${order.status})`, 422, "NO_CAPTURE", order.debug_id, order);
    if (capture.status !== "COMPLETED") {
      throw new PayPalError(`capture ${capture.id} is ${capture.status} (${capture.status_details?.reason ?? "no reason"})`, 422, "CAPTURE_NOT_COMPLETED", undefined, capture);
    }
    return { orderId: json.id as string, captureId: capture.id as string, status: capture.status as string };
  }

  async createTopupOrder(input: { amount: Money; customId: string; returnUrl: string; cancelUrl: string; requestId: string }) {
    const json = await this.call(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: input.customId, custom_id: input.customId, description: "Recourse prepaid balance", amount: toPayPalAmount(input.amount) }],
        payment_source: { paypal: { experience_context: this.experience(input.returnUrl, input.cancelUrl, { user_action: "PAY_NOW" }) } },
      },
      { requestId: input.requestId },
    );
    return { orderId: json.id as string, approveUrl: PayPalRest.link(json, "payer-action", "approve") };
  }

  async captureOrder(orderId: string, requestId: string) {
    const json = await this.call("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { requestId });
    const capture = json.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) throw new PayPalError(`order ${orderId} has no capture`, 422, "NO_CAPTURE", json.debug_id, json);
    return {
      captureId: capture.id as string,
      status: capture.status as string,
      amount: { currency: capture.amount.currency_code as string, minor: fromPayPalValue(capture.amount.value) },
      customId: (capture.custom_id ?? json.purchase_units?.[0]?.custom_id) as string | undefined,
    };
  }

  async refundCapture(input: { captureId: string; amount: Money; note: string; requestId: string }) {
    const json = await this.call(
      "POST",
      `/v2/payments/captures/${input.captureId}/refund`,
      { amount: toPayPalAmount(input.amount), note_to_payer: input.note.slice(0, 255) },
      { requestId: input.requestId },
    );
    return { refundId: json.id as string, status: json.status as string };
  }

  // ---------- payouts ----------

  async createPayout(input: { senderBatchId: string; emailSubject: string; items: { receiverEmail: string; amount: Money; note: string; senderItemId: string }[] }) {
    const json = await this.call(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: input.emailSubject },
        items: input.items.map((i) => ({
          recipient_type: "EMAIL",
          receiver: i.receiverEmail,
          // Payouts uses `currency`, Orders and Refunds use `currency_code`.
          amount: { value: toPayPalValue(i.amount.minor), currency: i.amount.currency },
          note: i.note,
          sender_item_id: i.senderItemId,
        })),
      },
      { requestId: `payout-${input.senderBatchId}` },
    );
    return { payoutBatchId: json.batch_header.payout_batch_id as string, status: json.batch_header.batch_status as string };
  }

  async getPayout(payoutBatchId: string) {
    const json = await this.call("GET", `/v1/payments/payouts/${payoutBatchId}`);
    return {
      status: json.batch_header.batch_status as string,
      items: ((json.items ?? []) as Json[]).map((i) => ({ senderItemId: i.payout_item?.sender_item_id as string, status: i.transaction_status as string })),
    };
  }

  // ---------- disputes (merchant side) ----------

  async listDisputes(state = "REQUIRED_ACTION"): Promise<DisputeSummary[]> {
    const json = await this.call("GET", `/v1/customer/disputes?dispute_state=${state}&page_size=50`);
    return ((json.items ?? []) as Json[]).map((d) => ({
      disputeId: d.dispute_id,
      status: d.status,
      reason: d.reason,
      amount: d.dispute_amount ? { currency: d.dispute_amount.currency_code, minor: fromPayPalValue(d.dispute_amount.value) } : undefined,
      createTime: d.create_time,
    }));
  }

  async getDispute(disputeId: string) {
    const d = await this.call("GET", `/v1/customer/disputes/${disputeId}`);
    return {
      disputeId: d.dispute_id as string,
      status: d.status as string,
      reason: d.reason as string,
      captureIds: ((d.disputed_transactions ?? []) as Json[]).map((t) => t.seller_transaction_id as string).filter(Boolean),
      links: ((d.links ?? []) as { rel: string }[]).map((l) => l.rel),
      raw: d,
    };
  }

  async provideDisputeEvidence(disputeId: string, notes: string, files: { filename: string; type: string; data: Uint8Array }[] = []) {
    await this.multipart(
      `/v1/customer/disputes/${disputeId}/provide-evidence`,
      { evidences: [{ evidence_type: "OTHER", notes: notes.slice(0, 2000) }] },
      files.map((f, i) => ({ name: `file${i + 1}`, ...f })),
    );
  }

  async acceptDisputeClaim(disputeId: string, note: string, refund?: Money) {
    await this.call("POST", `/v1/customer/disputes/${disputeId}/accept-claim`, {
      note: note.slice(0, 255),
      accept_claim_type: refund ? "PARTIAL_REFUND" : "REFUND",
      ...(refund ? { refund_amount: toPayPalAmount(refund) } : {}),
    });
  }

  // ---------- webhooks ----------

  async verifyWebhook(input: { headers: Record<string, string | undefined>; body: string; webhookId: string }) {
    const h = (k: string) => input.headers[k] ?? input.headers[k.toLowerCase()];
    // The raw body must be embedded byte-identical; re-serialized JSON fails verification.
    const payload = `{"auth_algo":${JSON.stringify(h("PAYPAL-AUTH-ALGO"))},"cert_url":${JSON.stringify(h("PAYPAL-CERT-URL"))},"transmission_id":${JSON.stringify(
      h("PAYPAL-TRANSMISSION-ID"),
    )},"transmission_sig":${JSON.stringify(h("PAYPAL-TRANSMISSION-SIG"))},"transmission_time":${JSON.stringify(h("PAYPAL-TRANSMISSION-TIME"))},"webhook_id":${JSON.stringify(
      input.webhookId,
    )},"webhook_event":${input.body}}`;
    const res = await this.f(`${this.base}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: payload,
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    return json.verification_status === "SUCCESS";
  }
}

export function paypalFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalRest | undefined {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return undefined;
  if (env.PAYPAL_ENV && env.PAYPAL_ENV !== "sandbox") throw new Error("PAYPAL_ENV must be sandbox");
  return new PayPalRest({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
}
