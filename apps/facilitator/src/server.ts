import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { FakePayPal, paypalFromEnv, type PayPalApi } from "@recourse/paypal";
import { encodeJwk, generateSigner, noopAnchorer, signerFromEnv, type Anchorer, type Signer } from "@recourse/receipts";
import { jevJudgeFromEnv, OfflineJudge, secondOpinionFrom } from "@recourse/judge";
import { openPglite, openPostgres, SCHEMA, type Db } from "./db";
import { createApp } from "./http";
import { DEFAULT_CONFIG, Facilitator } from "./service";

const env = process.env;
const PORT = Number(env.PORT ?? 4020);
const DATA_DIR = env.RECOURSE_DATA_DIR ?? ".data";
const publicBaseUrl = env.RECOURSE_PUBLIC_URL ?? `http://localhost:${PORT}`;

// The signing key is Recourse's identity in every receipt. Locally it is created
// once and kept in .data; hosted, it comes from the environment.
function loadSigner(): Signer {
  if (env.RECOURSE_SIGNING_KEY) return signerFromEnv(env.RECOURSE_SIGNING_KEY_ID ?? "recourse-1", env.RECOURSE_SIGNING_KEY);
  mkdirSync(DATA_DIR, { recursive: true });
  const file = `${DATA_DIR}/signing-key.txt`;
  if (!existsSync(file)) {
    const { privateJwk } = generateSigner("recourse-local");
    writeFileSync(file, encodeJwk(privateJwk), { mode: 0o600 });
    console.log(`[recourse] created a new signing key in ${file}`);
  }
  return signerFromEnv("recourse-local", readFileSync(file, "utf8").trim());
}

async function loadAnchorer(): Promise<Anchorer> {
  if (env.RECOURSE_ANCHOR === "off") return noopAnchorer;
  try {
    const { openTimestampsAnchorer } = await import("@recourse/receipts/ots");
    return openTimestampsAnchorer();
  } catch (e) {
    console.warn(`[recourse] OpenTimestamps unavailable, anchoring off: ${(e as Error).message}`);
    return noopAnchorer;
  }
}

async function main() {
  const db: Db = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL) : await openPglite(`${DATA_DIR}/pglite`);
  await db.exec(SCHEMA);

  const paypal: PayPalApi = paypalFromEnv() ?? new FakePayPal({ autoApprove: true });
  const judge = jevJudgeFromEnv() ?? new OfflineJudge();
  const f = new Facilitator(db, paypal, loadSigner(), secondOpinionFrom(judge), await loadAnchorer(), {
    ...DEFAULT_CONFIG,
    publicBaseUrl,
    fundingThresholdMinor: Number(env.RECOURSE_FUNDING_THRESHOLD ?? DEFAULT_CONFIG.fundingThresholdMinor),
  });

  if (paypal.mode === "sandbox") {
    const scopes = await (paypal as unknown as { scopes(): Promise<string[]> }).scopes();
    const has = (s: string) => scopes.some((x) => x.includes(s));
    console.log(`[recourse] PayPal sandbox: vault=${has("vault/payment-tokens")} payouts=${has("payments/payouts")} disputes=${has("disputes/update-seller")}`);
  } else {
    console.log("[recourse] PayPal: fake (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for the sandbox)");
  }
  console.log(`[recourse] judge: ${judge.constructor.name}`);

  const app = createApp(f, {
    adminToken: env.RECOURSE_ADMIN_TOKEN ?? "dev-admin-token",
    appBaseUrl: env.RECOURSE_APP_URL ?? "http://localhost:3000",
    ...(env.PAYPAL_WEBHOOK_ID ? { webhookId: env.PAYPAL_WEBHOOK_ID } : {}),
  });

  // Background duties. Short intervals because the demo runs in minutes, not days.
  const every = (ms: number, name: string, fn: () => Promise<unknown>) =>
    setInterval(() => void fn().catch((e) => console.error(`[recourse] ${name}:`, (e as Error).message)), ms).unref();
  every(Number(env.RECOURSE_ANCHOR_EVERY_MS ?? 10 * 60_000), "anchor", () => f.anchorHead());
  every(30 * 60_000, "anchor-upgrade", () => f.upgradeAnchors());
  every(Number(env.RECOURSE_PAYOUT_EVERY_MS ?? 60_000), "payouts", () => f.runPayouts());
  if (paypal.mode === "sandbox") every(2 * 60_000, "disputes", () => f.answerDisputes());

  serve({ fetch: app.fetch, port: PORT }, () => console.log(`[recourse] facilitator on ${publicBaseUrl}`));
}

void main();
