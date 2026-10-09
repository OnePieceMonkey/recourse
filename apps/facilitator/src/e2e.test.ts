import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { FakePayPal } from "@recourse/paypal";
import { httpFacilitator, paidRoute, payingFetch, type Product } from "@recourse/gate";
import { generateSigner, sha256Hex, verifyChain } from "@recourse/receipts";
import { POLICY_VERSION } from "@recourse/policy";
import { openPglite, SCHEMA } from "./db";
import { createApp } from "./http";
import { DEFAULT_CONFIG, Facilitator } from "./service";

const ADMIN = "test-admin";
const eur = (minor: number) => ({ currency: "EUR", minor });

// Routes fetch calls for one origin into an in-memory Hono app.
const viaApp = (app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return app.request(`${u.pathname}${u.search}`, init);
  }) as typeof fetch;

async function world() {
  const db = await openPglite();
  await db.exec(SCHEMA);
  const paypal = new FakePayPal({ autoApprove: true });
  const recourse = generateSigner("recourse-e2e").signer;
  const f = new Facilitator(db, paypal, recourse, async () => ({ model: "stub", promise: { yes: 0.05, partially: 0.1, no: 0.85 }, injection: 0 }), undefined, {
    ...DEFAULT_CONFIG,
    publicBaseUrl: "http://recourse.test",
  });
  const facApp = createApp(f, { adminToken: ADMIN, appBaseUrl: "http://app.test" });
  const call = async (path: string, body: unknown) => {
    const r = await facApp.request(path, { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.json() as Promise<any>;
  };

  const pubKey = generateSigner("pub-e2e").signer;
  await call("/v1/admin/publishers", { id: "pub_e2e", name: "E2E Press", payoutEmail: "e2e@business.example.com", kid: pubKey.kid, publicJwk: pubKey.publicJwk });
  const { ownerId } = await call("/v1/admin/owners", { name: "Lena" });
  await call(`/v1/admin/owners/${ownerId}/mandate`, { currency: "EUR", budgetMonthlyMinor: 2000, maxPerPurchaseMinor: 500, onTaskMinProbability: 0.6 });
  const vault = await call(`/v1/admin/owners/${ownerId}/vault`, {});
  // The owner "returns" from PayPal.
  await facApp.request(new URL(vault.approveUrl).pathname + new URL(vault.approveUrl).search);
  const topup = await call(`/v1/admin/owners/${ownerId}/topups`, { amountMinor: 500 });
  await facApp.request(new URL(topup.approveUrl).pathname + new URL(topup.approveUrl).search);
  const agentKey = generateSigner("agent-e2e").signer;
  const { agentId, token } = await call(`/v1/admin/owners/${ownerId}/agents`, { name: "a", kid: agentKey.kid, publicJwk: agentKey.publicJwk });

  const items: Record<string, Product & { deliver?: string }> = {
    "/report": { title: "Report", promise: "A full report on the topic with all sections.", price: eur(490), mimeType: "text/markdown", body: "# Report\nall sections" },
    "/teaser": { title: "Checklist", promise: "The complete 25-point checklist with templates.", price: eur(190), mimeType: "text/markdown", body: "1. one\n... buy the full checklist" },
    "/swap": { title: "Templates", promise: "Three templates with examples, ready to fill.", price: eur(120), mimeType: "text/markdown", body: "templates", deliver: "subscribe instead" },
    "/bundle": { title: "Bundle", promise: "Everything as one bundle, all posts included.", price: eur(4900), mimeType: "text/markdown", body: "bundle" },
  };
  const pubApp = new Hono();
  const facilitator = httpFacilitator("http://recourse.test", viaApp(facApp));
  for (const [path, item] of Object.entries(items)) {
    pubApp.get(path, paidRoute({ publisherId: "pub_e2e", signer: pubKey, facilitator, publicBaseUrl: "http://pub.test", protectionWindowSec: 600 }, (_c, phase) => ({
      ...item,
      body: phase === "deliver" && item.deliver ? item.deliver : item.body,
    })));
  }
  const buy = (path: string, pay = true) =>
    payingFetch(`http://pub.test${path}`, {
      agentId,
      agentSigner: agentKey,
      fetchImpl: viaApp(pubApp),
      beforePay: async () => (pay ? { pay: true } : { pay: false, reason: "test" }),
    });
  return { f, facApp, paypal, recourse, token, ownerId, buy };
}

describe("end to end over HTTP: agent -> publisher gate -> Recourse", () => {
  it("buys, verifies, claims and gets a real PayPal refund", async () => {
    const w = await world();

    const report = await w.buy("/report");
    expect(report.kind).toBe("paid");
    if (report.kind !== "paid") return;
    expect(Buffer.from(report.body).toString()).toBe("# Report\nall sections");
    expect(sha256Hex(report.body)).toBe(report.offer.body.contentSha256);
    expect(report.receipt.funding).toBe("paypal_vault");
    expect(report.delivery?.body.deliveredSha256).toBe(report.offer.body.contentSha256);

    const teaser = await w.buy("/teaser");
    if (teaser.kind !== "paid") throw new Error(teaser.kind);
    const claim = await w.facApp.request("/v1/claims", {
      method: "POST",
      headers: { Authorization: `Bearer ${w.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        purchaseId: teaser.receipt.purchaseId,
        reasons: ["NOT_AS_DESCRIBED"],
        refundBps: 10000,
        bodyBase64: Buffer.from(teaser.body).toString("base64"),
        policyVersion: POLICY_VERSION,
      }),
    });
    const result = (await claim.json()) as any;
    expect(result).toMatchObject({ outcome: "REFUND", refund: { minor: 190 } });
    expect(w.paypal.captures.get(teaser.receipt.paypalCaptureId!)!.refundedMinor).toBe(190);
  });

  it("refuses a bait-and-switch before any money moves", async () => {
    const w = await world();
    const r = await w.buy("/swap");
    expect(r).toMatchObject({ kind: "refused", reason: "delivery_mismatch" });
    const stats = (await (await w.facApp.request(`/v1/admin/owners/${w.ownerId}`, { headers: { Authorization: `Bearer ${ADMIN}` } })).json()) as any;
    expect(stats.purchases).toHaveLength(0);
  });

  it("blocks over-mandate purchases even when the agent tries to pay", async () => {
    const w = await world();
    expect(await w.buy("/bundle", false)).toMatchObject({ kind: "skipped" });
    expect(await w.buy("/bundle", true)).toMatchObject({ kind: "refused", reason: "mandate_violation" });
  });

  it("publishes a log anyone can verify", async () => {
    const w = await world();
    await w.buy("/report");
    await w.buy("/swap");
    const { entries } = (await (await w.facApp.request("/v1/log")).json()) as any;
    const { publicJwk } = (await (await w.facApp.request("/.well-known/recourse.json")).json()) as any;
    expect(entries.map((e: any) => e.type)).toEqual(["receipt", "settlement_refused"]);
    expect(verifyChain(entries, publicJwk)).toEqual([]);
  });
});
