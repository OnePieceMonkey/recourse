import { checkMandate, decideClaim, POLICY_VERSION, type ClaimDecision, type Mandate, type Verdict } from "@recourse/policy";
import { ClaimResultSchema, type ClaimResult, type SignedOffer } from "@recourse/protocol";
import { sha256Hex, type Signer } from "@recourse/receipts";
import { extractInspectableText, type Judge } from "@recourse/judge";
import type { CatalogEntry, Writer, Answer } from "./llm";
import type { PayPalCheck } from "./audit";
import { payingFetch, type PaidReceipt } from "@recourse/gate";

export interface AgentConfig {
  facilitatorUrl: string;
  catalogUrl: string;
  agentId: string;
  agentToken: string;
  agentSigner: Signer;
  mandateText: string;
}

export type AgentEvent =
  | { type: "start"; question: string; writer: string; judge: string }
  | { type: "catalog"; items: CatalogEntry[] }
  | { type: "plan"; picks: { url: string; title: string; price: CatalogEntry["price"]; reason: string }[] }
  | { type: "offer"; url: string; offer: SignedOffer["body"] }
  | { type: "mandate"; url: string; allow: boolean; reasons: string[]; onTask?: number | undefined }
  | { type: "paid"; url: string; receipt: PaidReceipt; price: CatalogEntry["price"] }
  | { type: "refused"; url: string; reason: string; message?: string | undefined }
  | { type: "verified"; url: string; hashMatches: boolean; verdict: Verdict; details: unknown; decision: ClaimDecision }
  | { type: "claim"; url: string; result: ClaimResult }
  | { type: "paypal_check"; url: string; check: PayPalCheck }
  | { type: "answer"; answer: Answer }
  | { type: "summary"; spentMinor: number; refundedMinor: number; blocked: number; refused: number; quarantined: number; used: number }
  | { type: "error"; message: string };

interface Me {
  ownerId: string;
  mandate?: Mandate;
  spentThisMonthMinor: number;
}

const decode = (b: Uint8Array) => Buffer.from(b).toString("utf8");

export interface RefundAuditor {
  checkRefund(refundId: string): Promise<PayPalCheck>;
}

export async function runResearch(
  question: string,
  cfg: AgentConfig,
  writer: Writer,
  judge: Judge,
  emit: (e: AgentEvent) => void,
  auditor?: RefundAuditor,
) {
  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${cfg.facilitatorUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${cfg.agentToken}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
    return body as T;
  };

  emit({ type: "start", question, writer: writer.name, judge: judge.name });
  const me = await api<Me>("/v1/agent/me");
  if (!me.mandate) throw new Error("the owner has not set a mandate");
  const mandate = me.mandate;
  let spent = me.spentThisMonthMinor;

  const catalog = (await (await fetch(cfg.catalogUrl)).json()) as CatalogEntry[];
  emit({ type: "catalog", items: catalog });
  const picks = await writer.pickSources(question, catalog);
  const byUrl = new Map(catalog.map((c) => [c.url, c]));
  emit({ type: "plan", picks: picks.map((p) => ({ ...p, title: byUrl.get(p.url)!.title, price: byUrl.get(p.url)!.price })) });

  const usable: { url: string; title: string; publisher: string; text: string }[] = [];
  let spentNow = 0;
  let refunded = 0;
  let blocked = 0;
  let refused = 0;
  let quarantined = 0;

  for (const pick of picks) {
    const entry = byUrl.get(pick.url)!;
    try {
      const result = await payingFetch(pick.url, {
        agentId: cfg.agentId,
        agentSigner: cfg.agentSigner,
        beforePay: async (offer) => {
          emit({ type: "offer", url: pick.url, offer: offer.body });
          // Numbers in code first; the judge only answers "is this on-task".
          const numeric = checkMandate(
            { publisherId: offer.body.publisherId, priceMinor: offer.body.price.minor, currency: offer.body.price.currency },
            mandate,
            { spentThisMonthMinor: spent },
          );
          if (!numeric.allow) {
            emit({ type: "mandate", url: pick.url, allow: false, reasons: numeric.reasons });
            return { pay: false, reason: numeric.reasons.join(",") };
          }
          const { verdict } = await judge.judgePurchase({
            mandateText: cfg.mandateText,
            userTask: question,
            proposed: { seller: entry.publisher, title: offer.body.title, promise: offer.body.promise, accessTerms: `One-time purchase, license: ${offer.body.license}.` },
          });
          const full = checkMandate(
            { publisherId: offer.body.publisherId, priceMinor: offer.body.price.minor, currency: offer.body.price.currency },
            mandate,
            { spentThisMonthMinor: spent },
            verdict,
          );
          emit({ type: "mandate", url: pick.url, allow: full.allow, reasons: full.reasons, onTask: verdict.onTask });
          return full.allow ? { pay: true } : { pay: false, reason: full.reasons.join(",") };
        },
      });

      if (result.kind === "skipped") {
        blocked += 1;
        continue;
      }
      if (result.kind === "refused") {
        refused += 1;
        emit({ type: "refused", url: pick.url, reason: result.reason, message: result.message });
        continue;
      }
      if (result.kind === "free") continue;

      spent += result.offer.body.price.minor;
      spentNow += result.offer.body.price.minor;
      emit({ type: "paid", url: pick.url, receipt: result.receipt, price: result.offer.body.price });

      // Verify before anything reaches the generative model.
      const hashMatches = sha256Hex(result.body) === result.offer.body.contentSha256;
      const text = decode(result.body);
      const judged = hashMatches
        ? await judge.judgeDelivery({
            userQuestion: question,
            offer: { seller: entry.publisher, title: result.offer.body.title, promise: result.offer.body.promise },
            body: text,
            mimeType: result.offer.body.mimeType,
            url: pick.url,
          })
        : undefined;
      const verdict: Verdict = judged?.verdict ?? { model: "none" };
      const decision = decideClaim({ hashMatches, ...(judged && Object.keys(judged.verdict).length > 1 ? { verdict: judged.verdict } : {}) });
      emit({ type: "verified", url: pick.url, hashMatches, verdict, details: judged?.details ?? null, decision });

      if (decision.quarantine) quarantined += 1;
      if (!decision.quarantine && decision.action === "accept") {
        usable.push({ url: pick.url, title: result.offer.body.title, publisher: entry.publisher, text: extractInspectableText(text, result.offer.body.mimeType).text });
      }
      if (decision.action === "claim") {
        const claim = ClaimResultSchema.parse(
          await api("/v1/claims", {
            method: "POST",
            body: JSON.stringify({
              purchaseId: result.receipt.purchaseId,
              reasons: decision.reasons,
              refundBps: decision.refundBps,
              bodyBase64: Buffer.from(result.body).toString("base64"),
              ...(result.delivery ? { delivery: result.delivery } : {}),
              agentVerdict: verdict,
              policyVersion: POLICY_VERSION,
            }),
          }),
        );
        refunded += claim.refund.minor;
        emit({ type: "claim", url: pick.url, result: claim });
        if (claim.paypalRefundId && auditor) emit({ type: "paypal_check", url: pick.url, check: await auditor.checkRefund(claim.paypalRefundId) });
      }
    } catch (e) {
      emit({ type: "error", message: `${pick.url}: ${(e as Error).message}` });
    }
  }

  const answer = await writer.writeAnswer(question, usable);
  emit({ type: "answer", answer });
  emit({ type: "summary", spentMinor: spentNow, refundedMinor: refunded, blocked, refused, quarantined, used: usable.length });
}
