import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { httpFacilitator, paidRoute, type Product } from "@recourse/gate";
import { encodeJwk, generateSigner, signerFromEnv, type Signer } from "@recourse/receipts";
import * as content from "./content";

const env = process.env;
const PORT = Number(env.PORT ?? 4030);
const publicBaseUrl = env.PUBLISHER_PUBLIC_URL ?? `http://localhost:${PORT}`;
const facilitatorUrl = env.RECOURSE_FACILITATOR_URL ?? "http://localhost:4020";
const adminToken = env.RECOURSE_ADMIN_TOKEN ?? "dev-admin-token";
const DATA_DIR = env.RECOURSE_DATA_DIR ?? ".data";
const eur = (minor: number) => ({ currency: "EUR", minor });

interface DemoPublisher {
  id: string;
  name: string;
  payoutEmail: string;
}

// Three publishers with different characters. Payout e-mails must be sandbox
// business accounts for real payouts; override them via env.
const PUBLISHERS: Record<string, DemoPublisher> = {
  northwind: { id: "pub_northwind", name: "Northwind Compliance", payoutEmail: env.PAYOUT_EMAIL_NORTHWIND ?? "northwind@business.example.com" },
  quickcheck: { id: "pub_quickcheck", name: "QuickCheck Media", payoutEmail: env.PAYOUT_EMAIL_QUICKCHECK ?? "quickcheck@business.example.com" },
  tipjar: { id: "pub_tipjar", name: "TipJar Blog", payoutEmail: env.PAYOUT_EMAIL_TIPJAR ?? "tipjar@business.example.com" },
};

function keyFor(slug: string): Signer {
  const kid = `${slug}-key-1`;
  const fromEnv = env[`PUBLISHER_KEY_${slug.toUpperCase()}`];
  if (fromEnv) return signerFromEnv(kid, fromEnv);
  mkdirSync(DATA_DIR, { recursive: true });
  const file = `${DATA_DIR}/publisher-${slug}.key`;
  if (!existsSync(file)) writeFileSync(file, encodeJwk(generateSigner(kid).privateJwk), { mode: 0o600 });
  return signerFromEnv(kid, readFileSync(file, "utf8").trim());
}

interface CatalogItem extends Product {
  path: string;
  publisher: keyof typeof PUBLISHERS;
  deliver?: string; // when set, the publisher swaps the content after the offer
}

const CATALOG: CatalogItem[] = [
  {
    path: "/northwind/primer",
    publisher: "northwind",
    title: "E-invoicing in the EU: a primer",
    promise: "A short primer on EU e-invoicing: what EN 16931 is, the main formats (XRechnung, ZUGFeRD, Peppol) and the ViDA timeline.",
    price: eur(30),
    mimeType: "text/markdown",
    body: content.PRIMER,
  },
  {
    path: "/northwind/germany-2027",
    publisher: "northwind",
    title: "Germany 2027: e-invoicing for small businesses",
    promise:
      "A practical report for German small businesses: the 2025/2027/2028 timeline, what counts as an e-invoice, exemptions, and concrete steps for a business sending about 40 invoices a month.",
    price: eur(490),
    mimeType: "text/markdown",
    body: content.GERMANY_REPORT,
  },
  {
    path: "/quickcheck/checklist",
    publisher: "quickcheck",
    title: "Complete e-invoicing compliance checklist",
    promise: "The complete 25-point e-invoicing compliance checklist for German businesses, with a template for each step.",
    price: eur(190),
    mimeType: "text/markdown",
    body: content.CHECKLIST_TEASER,
  },
  {
    path: "/quickcheck/templates",
    publisher: "quickcheck",
    title: "XRechnung template pack",
    promise: "Three ready-to-fill XRechnung (CII) templates for services, goods and partial payments, each with a filled example.",
    price: eur(120),
    mimeType: "text/markdown",
    body: content.TEMPLATE_PACK_OFFERED,
    deliver: content.TEMPLATE_PACK_SWAPPED,
  },
  {
    path: "/tipjar/five-tips",
    publisher: "tipjar",
    title: "5 quick e-invoicing tips",
    promise: "Five short, practical tips for small businesses preparing for e-invoicing.",
    price: eur(5),
    mimeType: "text/html",
    body: content.POISONED_BLOG,
  },
  {
    path: "/tipjar/bundle/premium",
    publisher: "tipjar",
    title: "Premium Compliance Bundle",
    promise: "All TipJar Blog posts on e-invoicing as one PDF bundle.",
    price: eur(4900),
    mimeType: "text/markdown",
    body: content.PREMIUM_BUNDLE,
  },
];

async function register(slug: string, signer: Signer) {
  const p = PUBLISHERS[slug]!;
  const res = await fetch(`${facilitatorUrl}/v1/admin/publishers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id: p.id, name: p.name, payoutEmail: p.payoutEmail, kid: signer.kid, publicJwk: signer.publicJwk }),
  });
  if (!res.ok) throw new Error(`registering ${slug} failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const facilitator = httpFacilitator(facilitatorUrl);
  const signers = Object.fromEntries(Object.keys(PUBLISHERS).map((slug) => [slug, keyFor(slug)]));
  for (const slug of Object.keys(PUBLISHERS)) await register(slug, signers[slug]!);

  const app = new Hono();
  // Free discovery, like x402's Bazaar: what is for sale, at what price, promising what.
  app.get("/catalog", (c) =>
    c.json(
      CATALOG.map((i) => ({
        url: `${publicBaseUrl}${i.path}`,
        publisher: PUBLISHERS[i.publisher]!.name,
        publisherId: PUBLISHERS[i.publisher]!.id,
        title: i.title,
        promise: i.promise,
        price: i.price,
        mimeType: i.mimeType,
      })),
    ),
  );
  for (const item of CATALOG) {
    const p = PUBLISHERS[item.publisher]!;
    app.get(
      item.path,
      paidRoute({ publisherId: p.id, signer: signers[item.publisher]!, facilitator, publicBaseUrl, protectionWindowSec: Number(env.PROTECTION_WINDOW_SEC ?? 600) }, (_c, phase) => ({
        ...item,
        body: phase === "deliver" && item.deliver ? item.deliver : item.body,
      })),
    );
  }
  serve({ fetch: app.fetch, port: PORT }, () => console.log(`[publishers] ${CATALOG.length} items on ${publicBaseUrl}/catalog`));
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
