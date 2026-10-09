import { describe, expect, it } from "vitest";
import { PayPalRest } from "./rest";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

// A scripted stand-in for api-m.sandbox.paypal.com that records every request.
function mockPayPal(routes: Record<string, (body: any) => { status?: number; json: any }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" && headers["Content-Type"] === "application/json" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path: url.pathname + url.search, headers, body });
    if (url.pathname === "/v1/oauth2/token") {
      return new Response(JSON.stringify({ access_token: "A21-test", expires_in: 32400, scope: "https://uri.paypal.com/services/vault/payment-tokens/readwrite https://uri.paypal.com/payments/payouts" }));
    }
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(JSON.stringify({ name: "NOT_MOCKED" }), { status: 500 });
    const r = handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, client: new PayPalRest({ clientId: "id", clientSecret: "secret", fetchImpl }) };
}

describe("PayPalRest", () => {
  it("refuses anything but the sandbox", () => {
    expect(() => new PayPalRest({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox/);
  });

  it("charges a vaulted wallet merchant-initiated and reads the capture from the create response", async () => {
    const { calls, client } = mockPayPal({
      "POST /v2/checkout/orders": () => ({
        status: 201,
        json: { id: "ORD1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "EUR", value: "4.90" } }] } }] },
      }),
    });
    const r = await client.chargeVault({ vaultId: "vlt1", amount: { currency: "EUR", minor: 490 }, description: "Germany 2027 report", customId: "pur_1", requestId: "charge:pur_1" });
    expect(r).toEqual({ orderId: "ORD1", captureId: "CAP1", status: "COMPLETED" });
    const order = calls.find((c) => c.path === "/v2/checkout/orders")!;
    expect(order.headers["PayPal-Request-Id"]).toBe("charge:pur_1");
    expect(order.body.payment_source.paypal).toEqual({
      vault_id: "vlt1",
      stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_PREPAID" },
    });
    expect(order.body.purchase_units[0].amount).toEqual({ currency_code: "EUR", value: "4.90", breakdown: { item_total: { currency_code: "EUR", value: "4.90" } } });
    expect(order.body.purchase_units[0].items[0].category).toBe("DIGITAL_GOODS");
    expect(calls.filter((c) => c.path.endsWith("/capture"))).toHaveLength(0);
  });

  it("surfaces PSD2 payer-action errors with the issue code", async () => {
    const { client } = mockPayPal({
      "POST /v2/checkout/orders": () => ({ status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PAYER_ACTION_REQUIRED", description: "SCA" }], debug_id: "dbg" } }),
    });
    await expect(client.chargeVault({ vaultId: "v", amount: { currency: "EUR", minor: 100 }, description: "x", customId: "p", requestId: "r" })).rejects.toMatchObject({
      status: 422,
      name_: "PAYER_ACTION_REQUIRED",
    });
  });

  it("creates a vault setup token for merchant-initiated, unscheduled use", async () => {
    const { calls, client } = mockPayPal({
      "POST /v3/vault/setup-tokens": () => ({ status: 201, json: { id: "ST1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "approve", href: "https://sandbox.paypal.com/agreements/approve?approval_session_id=ST1" }] } }),
    });
    const r = await client.createVaultSetupToken({ returnUrl: "https://r/ok", cancelUrl: "https://r/no" });
    expect(r.approveUrl).toContain("approval_session_id=ST1");
    const p = calls.find((c) => c.path === "/v3/vault/setup-tokens")!.body.payment_source.paypal;
    expect(p).toMatchObject({ usage_type: "MERCHANT", customer_type: "CONSUMER", usage_pattern: "UNSCHEDULED_PREPAID" });
    expect(p.experience_context).toMatchObject({ return_url: "https://r/ok", shipping_preference: "NO_SHIPPING" });
  });

  it("sends payouts with `currency`, not `currency_code`", async () => {
    const { calls, client } = mockPayPal({
      "POST /v1/payments/payouts": () => ({ status: 201, json: { batch_header: { payout_batch_id: "PB1", batch_status: "PENDING" } } }),
    });
    await client.createPayout({
      senderBatchId: "pay_1",
      emailSubject: "s",
      items: [{ receiverEmail: "pub@business.example.com", amount: { currency: "EUR", minor: 340 }, note: "n", senderItemId: "pay_1:pub" }],
    });
    const body = calls.find((c) => c.path === "/v1/payments/payouts")!.body;
    expect(body.items[0].amount).toEqual({ value: "3.40", currency: "EUR" });
    expect(body.sender_batch_header.sender_batch_id).toBe("pay_1");
  });

  it("refunds partial amounts and caches the OAuth token", async () => {
    const { calls, client } = mockPayPal({
      "POST /v2/payments/captures/CAP1/refund": (b) => ({ status: 201, json: { id: "RF1", status: "COMPLETED", amount: b.amount } }),
    });
    await client.refundCapture({ captureId: "CAP1", amount: { currency: "EUR", minor: 5 }, note: "claim", requestId: "refund:c1" });
    await client.refundCapture({ captureId: "CAP1", amount: { currency: "EUR", minor: 5 }, note: "claim", requestId: "refund:c2" });
    const refunds = calls.filter((c) => c.path.endsWith("/refund"));
    expect(refunds[0]!.body.amount).toEqual({ currency_code: "EUR", value: "0.05" });
    expect(refunds.map((r) => r.headers["PayPal-Request-Id"])).toEqual(["refund:c1", "refund:c2"]);
    expect(calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
  });
});
