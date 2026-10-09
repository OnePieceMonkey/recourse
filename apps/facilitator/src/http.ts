import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { BINDING, EXT_OFFER, EXT_RECEIPT, SCHEME } from "@recourse/protocol";
import type { PublicJwk } from "@recourse/receipts";
import { Facilitator, RecourseError, toRecourseError } from "./service";

export interface HttpOptions {
  adminToken: string;
  webhookId?: string;
  // Where the owner lands after approving in PayPal (the web app).
  appBaseUrl: string;
}

const bearer = (c: Context) => c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

export function createApp(f: Facilitator, opts: HttpOptions) {
  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], exposeHeaders: ["PAYMENT-RESPONSE"] }));

  // Claims carry the delivered bytes; everything else is small JSON.
  const claimLimit = bodyLimit({ maxSize: 4 * 1024 * 1024 });
  const defaultLimit = bodyLimit({ maxSize: 512 * 1024 });
  app.use("*", (c, next) => (c.req.path === "/v1/claims" ? claimLimit(c, next) : defaultLimit(c, next)));

  app.onError((e, c) => {
    const err = toRecourseError(e);
    if (err.status >= 500) console.error(e);
    return c.json({ error: err.code, message: err.message }, err.status as 400);
  });

  const admin = async (c: Context, next: () => Promise<void>) => {
    if (bearer(c) !== opts.adminToken) throw new RecourseError("unauthorized", "admin token required", 401);
    await next();
  };

  // ---------- x402 facilitator API ----------
  app.get("/health", (c) => c.json({ ok: true, paypal: f.paypal.mode }));
  // Cloud Run only gives CPU while a request runs, so background timers stall when
  // idle. The uptime monitor calls this every few minutes and the work runs inside it.
  let lastTick = 0;
  app.get("/v1/tick", async (c) => {
    if (Date.now() - lastTick < 60_000) return c.json({ skipped: true });
    lastTick = Date.now();
    const settled = await Promise.allSettled([f.anchorHead(), f.upgradeAnchors(), f.runPayouts(), f.paypal.mode === "sandbox" ? f.answerDisputes() : Promise.resolve(null)]);
    return c.json({ ok: true, results: settled.map((r) => (r.status === "fulfilled" ? "ok" : String((r.reason as Error)?.message ?? r.reason))) });
  });
  app.get("/supported", (c) =>
    c.json({
      kinds: [{ x402Version: 2, scheme: SCHEME, network: f.config.network, extra: { binding: BINDING, paymentFlow: "authorization" } }],
      extensions: [EXT_OFFER, EXT_RECEIPT],
      signers: { "paypal:*": [f.signer.kid] },
    }),
  );
  app.post("/verify", async (c) => c.json(await f.verifyPayment(await c.req.json())));
  app.post("/settle", async (c) => c.json(await f.settlePayment(await c.req.json())));
  app.get("/.well-known/recourse.json", (c) => c.json({ kid: f.signer.kid, publicJwk: f.signer.publicJwk, network: f.config.network }));

  // ---------- agent API ----------
  app.post("/v1/claims", async (c) => c.json(await f.fileClaim(bearer(c), await c.req.json())));
  app.get("/v1/agent/me", async (c) => {
    const a = await f.authenticateAgent(bearer(c));
    return c.json({ ...a, ...(await f.ownerStats(a.ownerId)) });
  });

  // ---------- public transparency log ----------
  app.get("/v1/log/head", async (c) => c.json((await f.logHead()) ?? null));
  app.get("/v1/log", async (c) => {
    const head = await f.logHead();
    const to = Number(c.req.query("to") ?? head?.seq ?? 0);
    const from = Math.max(0, Number(c.req.query("from") ?? Math.max(0, to - 99)));
    return c.json({ entries: await f.logRange(from, Math.min(to, from + 499)), headSeq: head?.seq ?? -1 });
  });
  app.get("/v1/log/:seq", async (c) => {
    const seq = Number(c.req.param("seq"));
    const [entry] = await f.logRange(seq, seq);
    if (!entry) throw new RecourseError("not_found", "no such log entry", 404);
    return c.json(entry);
  });
  app.get("/v1/anchors", async (c) => c.json(await f.anchors()));

  // ---------- owner onboarding (demo: guarded by the admin token, used by the web app) ----------
  app.get("/v1/admin/owners", admin, async (c) => c.json(await f.db.query("SELECT id, name, vault_id IS NOT NULL AS paypal_connected, created_at FROM owners ORDER BY created_at")));
  app.get("/v1/admin/publishers", admin, async (c) => c.json(await f.db.query("SELECT id, name, kid, created_at FROM publishers ORDER BY created_at")));
  app.get("/v1/admin/claims", admin, async (c) =>
    c.json(
      await f.db.query(
        `SELECT c.id, c.purchase_id, c.outcome, c.refund_minor, c.decided_reasons, c.reasons, c.paypal_refund_id, c.log_seq, c.created_at,
                p.offer->>'title' AS title, p.publisher_id, p.price_minor, p.currency, p.funding
         FROM claims c JOIN purchases p ON p.id = c.purchase_id ORDER BY c.created_at DESC LIMIT 200`,
      ),
    ),
  );
  app.post("/v1/admin/owners", admin, async (c) => c.json(await f.createOwner((await c.req.json()).name ?? "Owner")));
  app.get("/v1/admin/owners/:id", admin, async (c) => c.json(await f.ownerStats(c.req.param("id")!)));
  app.post("/v1/admin/owners/:id/vault", admin, async (c) =>
    c.json(await f.startVaultSetup(c.req.param("id")!, `${f.config.publicBaseUrl}/v1/paypal/vault-return`, `${opts.appBaseUrl}/owner?vault=cancelled`)),
  );
  app.post("/v1/admin/owners/:id/mandate", admin, async (c) => c.json(await f.setMandate(c.req.param("id")!, await c.req.json())));
  app.post("/v1/admin/owners/:id/agents", admin, async (c) => {
    const b = (await c.req.json()) as { name: string; kid: string; publicJwk: PublicJwk };
    return c.json(await f.createAgent(c.req.param("id")!, b.name, b.kid, b.publicJwk));
  });
  app.post("/v1/admin/owners/:id/topups", admin, async (c) => {
    const b = (await c.req.json()) as { amountMinor: number; currency?: string };
    return c.json(
      await f.startTopup(c.req.param("id")!, b.amountMinor, b.currency ?? "EUR", `${f.config.publicBaseUrl}/v1/paypal/topup-return`, `${opts.appBaseUrl}/owner?topup=cancelled`),
    );
  });
  app.post("/v1/admin/publishers", admin, async (c) => c.json(await f.registerPublisher(await c.req.json())));
  app.get("/v1/admin/publishers/:id", admin, async (c) => c.json(await f.publisherStats(c.req.param("id")!)));
  app.post("/v1/admin/payouts/run", admin, async (c) => c.json(await f.runPayouts()));
  app.post("/v1/admin/anchor", admin, async (c) => c.json((await f.anchorHead()) ?? null));
  app.post("/v1/admin/disputes/sync", admin, async (c) => c.json(await f.answerDisputes()));

  // ---------- PayPal redirects and webhooks ----------
  // PayPal sends the owner back here after approving; we finish server side and
  // forward to the web app. Query parameter names differ between flows, so accept both.
  app.get("/v1/paypal/vault-return", async (c) => {
    const id = c.req.query("approval_token_id") ?? c.req.query("approval_session_id") ?? c.req.query("token");
    if (!id) throw new RecourseError("bad_request", "missing setup token id", 400);
    await f.completeVaultSetup(id);
    return c.redirect(`${opts.appBaseUrl}/owner?vault=connected`);
  });
  app.get("/v1/paypal/topup-return", async (c) => {
    const id = c.req.query("token");
    if (!id) throw new RecourseError("bad_request", "missing order id", 400);
    await f.completeTopup(id);
    return c.redirect(`${opts.appBaseUrl}/owner?topup=done`);
  });
  app.post("/v1/paypal/webhook", async (c) => {
    const raw = await c.req.text();
    const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toUpperCase(), v]));
    const ok = opts.webhookId ? await f.paypal.verifyWebhook({ headers, body: raw, webhookId: opts.webhookId }) : false;
    if (!ok) return c.json({ ignored: true }, 200);
    const event = JSON.parse(raw) as { event_type?: string };
    // Answer fast, work after: disputes are re-read from the API, never trusted from the event body.
    if (event.event_type?.startsWith("CUSTOMER.DISPUTE")) queueMicrotask(() => void f.answerDisputes().catch(console.error));
    return c.json({ received: true });
  });

  return app;
}
