import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { encodeJwk, generateSigner, signerFromEnv } from "@recourse/receipts";
import { jevJudgeFromEnv, OfflineJudge } from "@recourse/judge";
import { writerFromEnv } from "./llm";
import { paypalAuditorFromEnv } from "./audit";
import { runResearch, type AgentConfig, type AgentEvent } from "./research";

const env = process.env;
// One data dir at the repo root, whichever directory a service is started from.
const DATA_DIR = env.RECOURSE_DATA_DIR ?? new URL("../../../.data", import.meta.url).pathname;
const facilitatorUrl = env.RECOURSE_FACILITATOR_URL ?? "http://localhost:4020";
const catalogUrl = env.RECOURSE_CATALOG_URL ?? "http://localhost:4030/catalog";
const adminToken = env.RECOURSE_ADMIN_TOKEN ?? "dev-admin-token";
const STATE = `${DATA_DIR}/agent.json`;

const MANDATE_TEXT =
  "Buy research sources that help answer the user's question: single articles, reports, checklists or templates with one-time access. " +
  "Not allowed: subscriptions or recurring charges, software, physical goods, donations, tips, or access to personal data about individuals.";

interface State {
  ownerId: string;
  agentId: string;
  agentToken: string;
  agentKey: string;
}

async function admin<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${facilitatorUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

// One-time demo setup: owner, PayPal vault, mandate, top-up, agent key.
async function setup() {
  mkdirSync(DATA_DIR, { recursive: true });
  const { ownerId } = await admin<{ ownerId: string }>("/v1/admin/owners", { name: env.OWNER_NAME ?? "Lena" });
  await admin(`/v1/admin/owners/${ownerId}/mandate`, {
    currency: "EUR",
    budgetMonthlyMinor: Number(env.MANDATE_BUDGET_MINOR ?? 5000),
    maxPerPurchaseMinor: Number(env.MANDATE_MAX_MINOR ?? 500),
    onTaskMinProbability: 0.6,
  });
  const vault = await admin<{ approveUrl: string }>(`/v1/admin/owners/${ownerId}/vault`, {});
  const topup = await admin<{ approveUrl: string }>(`/v1/admin/owners/${ownerId}/topups`, { amountMinor: Number(env.TOPUP_MINOR ?? 2000) });
  const { privateJwk, signer } = generateSigner("agent-key-1");
  const { agentId, token } = await admin<{ agentId: string; token: string }>(`/v1/admin/owners/${ownerId}/agents`, {
    name: "research-agent",
    kid: signer.kid,
    publicJwk: signer.publicJwk,
  });
  const state: State = { ownerId, agentId, agentToken: token, agentKey: encodeJwk(privateJwk) };
  writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`owner ${ownerId}, agent ${agentId} saved to ${STATE}`);
  console.log(`\n1) Connect PayPal (log in with the sandbox PERSONAL account):\n   ${vault.approveUrl}`);
  console.log(`\n2) Top up the prepaid balance:\n   ${topup.approveUrl}\n`);
}

function loadConfig(): AgentConfig {
  // Hosted: the agent's identity comes from a secret, so restarts keep the same owner.
  const raw = env.RECOURSE_AGENT_STATE ? Buffer.from(env.RECOURSE_AGENT_STATE, "base64").toString("utf8") : existsSync(STATE) ? readFileSync(STATE, "utf8") : undefined;
  if (!raw) throw new Error(`no ${STATE}; run "pnpm --filter @recourse/agent start setup" first`);
  const s = JSON.parse(raw) as State;
  return {
    facilitatorUrl,
    catalogUrl,
    agentId: s.agentId,
    agentToken: s.agentToken,
    agentSigner: signerFromEnv("agent-key-1", s.agentKey),
    mandateText: MANDATE_TEXT,
    ...(env.RECOURSE_FETCH_REWRITE ? { fetchImpl: rewritingFetch(env.RECOURSE_FETCH_REWRITE) } : {}),
  };
}

// "https://public/publishers=http://127.0.0.1:4030": same URLs the user sees, internal route.
function rewritingFetch(rule: string): typeof fetch {
  const [from, to] = rule.split("=") as [string, string];
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetch(url.startsWith(from) ? to + url.slice(from.length) : url, init);
  }) as typeof fetch;
}

const eur = (minor: number) => `${(minor / 100).toFixed(2)} EUR`;

function printEvent(e: AgentEvent) {
  switch (e.type) {
    case "start":
      return console.log(`\n? ${e.question}\n  writer ${e.writer}, judge ${e.judge}`);
    case "plan":
      return console.log(`\nplan: ${e.picks.length} sources\n${e.picks.map((p) => `  - ${p.title} (${eur(p.price.minor)})`).join("\n")}`);
    case "mandate":
      return console.log(`  mandate ${e.allow ? "ok" : "BLOCKED"} ${e.reasons.join(",")}${e.onTask !== undefined ? ` onTask=${e.onTask.toFixed(2)}` : ""}  ${e.url}`);
    case "paid":
      return console.log(`  paid ${eur(e.price.minor)} via ${e.receipt.funding}, receipt #${e.receipt.receipt.seq}`);
    case "refused":
      return console.log(`  REFUSED before charge: ${e.reason}`);
    case "verified":
      return console.log(
        `  verified: hash ${e.hashMatches ? "ok" : "MISMATCH"}, promise ${JSON.stringify(e.verdict.promise ?? {})}, injection ${e.verdict.injection ?? "-"} -> ${e.decision.action} ${e.decision.reasons.join(",")}${e.decision.quarantine ? " (quarantined)" : ""}`,
      );
    case "claim":
      return console.log(`  claim ${e.result.outcome}: refund ${eur(e.result.refund.minor)} ${e.result.paypalRefundId ? `PayPal ${e.result.paypalRefundId}` : ""}`);
    case "paypal_check":
      return console.log(`  PayPal confirms refund ${e.check.refundId}: ${e.check.status}${e.check.amount ? ` ${e.check.amount.value} ${e.check.amount.currency_code}` : ""}`);
    case "answer":
      return console.log(`\nanswer:\n${e.answer.answer}\n${e.answer.citations.map((c) => `  [${c.url}] "${c.quote}"`).join("\n")}`);
    case "summary":
      return console.log(
        `\nspent ${eur(e.spentMinor)}, refunded ${eur(e.refundedMinor)}, blocked ${e.blocked}, refused ${e.refused}, quarantined ${e.quarantined}, used ${e.used}`,
      );
    case "error":
      return console.error(`  error: ${e.message}`);
    default:
      return;
  }
}

const judge = () => jevJudgeFromEnv() ?? new OfflineJudge();

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "setup") return setup();
  if (cmd === "ask") {
    const question = rest.join(" ") || "My small business in Germany issues about 40 invoices a month. What do I have to do about e-invoicing by 2027?";
    return runResearch(question, loadConfig(), writerFromEnv(), judge(), printEvent, paypalAuditorFromEnv());
  }
  if (cmd === "serve") {
    const app = new Hono();
    app.use("*", cors({ origin: "*" }));
    // The hosted demo is public and every run costs model calls: one run at a time,
    // a few per visitor per hour, a daily cap overall. Counters live in memory
    // (Cloud Run runs a single instance).
    const PER_IP_HOUR = Number(env.RUNS_PER_IP_HOUR ?? 5);
    const PER_DAY = Number(env.RUNS_PER_DAY ?? 40);
    const byIp = new Map<string, number[]>();
    let day = new Date().toISOString().slice(0, 10);
    let today = 0;
    let running = false;
    app.get("/limits", (c) => c.json({ running, today, perDay: PER_DAY }));
    app.get("/run", (c) => {
      const ip = (c.req.header("x-forwarded-for") ?? "local").split(",")[0]!.trim();
      const now = Date.now();
      if (new Date().toISOString().slice(0, 10) !== day) {
        day = new Date().toISOString().slice(0, 10);
        today = 0;
      }
      const recent = (byIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
      const refuse = running ? "busy" : today >= PER_DAY ? "daily_limit" : recent.length >= PER_IP_HOUR ? "hourly_limit" : undefined;
      if (refuse) return c.json({ error: refuse, message: "The demo agent is rate limited. Try again in a moment." }, 429);
      running = true;
      today += 1;
      byIp.set(ip, [...recent, now]);
      return streamSSE(c, async (stream) => {
        const q = (c.req.query("q") ?? "").slice(0, 500);
        // A run finishes even if the viewer leaves; the lock is released either way.
        const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);
        try {
          await runResearch(q, loadConfig(), writerFromEnv(), judge(), (e) => void send(e.type, e), paypalAuditorFromEnv()).catch((err) =>
            send("error", { type: "error", message: (err as Error).message }),
          );
          await send("done", {});
        } finally {
          running = false;
        }
      });
    });
    const port = Number(env.PORT ?? 4040);
    serve({ fetch: app.fetch, port }, () => console.log(`[agent] streaming runs on http://localhost:${port}/run?q=...`));
    return;
  }
  console.log('usage: agent setup | agent ask "<question>" | agent serve');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
