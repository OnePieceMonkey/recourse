import { extractInspectableText } from "./extract";
import { capOnTask, heuristicInjection, offerInjection } from "./heuristics";
import type { DeliveryInput, Judge, JudgeResult, PromiseProbabilities, PurchaseInput, PurchaseResult } from "./types";

// Deterministic stand-in for Jev: tests, and the demo without an API key. Same
// output shape, plausible probabilities, no network.
export const OFFLINE_MODEL = "offline-heuristic-v1";

// Words that describe the format of a promise, not its content.
const STOP = new Set(
  ("about after also been before being both brief complete comprehensive could deep detailed dive does each every everything " +
    "explainer from full guide have here into introduction just many more most much must need only other over overview page " +
    "plain post practical primer report short should since such than that their them then there these they this those very " +
    "what when where which while will with would your blog article").split(" "),
);

function stem(word: string): string {
  const w = word.slice(0, 30);
  const m = /^(.{4,}?)(?:ings?|ions?|ments?|ed|es|s|e|ly)$/.exec(w);
  return (m ? m[1]! : w).slice(0, 6);
}

export function contentStems(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && !STOP.has(w)) out.add(stem(w));
  return out;
}

// Words that name the same subject for the offline judge. Jev does not need this.
const CONCEPTS: string[][] = [["invoic", "xrechn", "zugfer", "peppol", "16931", "rechnu"]];
const GENERIC = new Set(["small", "busine", "month", "issue", "german", "europe", "2025", "2026", "2027", "2028", "2030"]);

function withConcepts(stems: Set<string>): Set<string> {
  const out = new Set(stems);
  for (const group of CONCEPTS) if (group.some((g) => stems.has(g))) for (const g of group) out.add(g);
  return out;
}

const coverage = (wanted: Set<string>, have: Set<string>) =>
  wanted.size ? [...wanted].filter((w) => have.has(w)).length / wanted.size : 1;

const TEASER: Array<[RegExp, number, string]> = [
  [/\bfull\s+version\b/i, 0.3, "full version"],
  [/\b(?:buy|purchase|order|get|unlock|download)\s+(?:the\s+|our\s+)?(?:full|complete|entire|premium)\b/i, 0.35, "buy the full/complete"],
  [/\bcontinue\s+reading\b/i, 0.3, "continue reading"],
  [/\b(?:subscribe|sign\s+(?:up|in)|log\s*in|upgrade)\b[^.\n]{0,30}\bto\s+(?:read|continue|access|unlock|see|get)\b/i, 0.3, "sign in to continue"],
  [/\b(?:preview|excerpt|teaser)\b/i, 0.15, "preview"],
  [/\bremaining\s+(?:\d+\s+)?(?:items|steps|sections|pages|chapters|points|checks)\b/i, 0.25, "remaining items"],
];
const COUNTED = /\b(\d{1,3})\s+(?:[a-z-]+\s+){0,2}?(?:items|steps|points|checks|questions|tasks|entries|sections|chapters|tips|rules|requirements|templates|countries)\b/i;
const LIST_ITEM = /^\s*(?:[-*•☐☑✓]|\d{1,3}[.)]|\[[ x]\])\s+\S/;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Parts the promise names after a colon, e.g. "...: A, B and C". */
function promisedParts(promise: string): Set<string>[] {
  const colon = promise.indexOf(":");
  if (colon < 0) return [];
  return promise
    .slice(colon + 1)
    .split(/,|;|\band\b|\bplus\b/i)
    .map(contentStems)
    .filter((s) => s.size > 0);
}

/** Deficit in 0..~1.3: how far the delivery falls short of the promise. */
export function promiseDeficit(visible: string, all: string, promise: string): { deficit: number; signals: string[] } {
  const signals: string[] = [];
  let d = 0;
  const words = visible.split(/\s+/).filter(Boolean).length;
  if (words < 80) (d += 0.4), signals.push(`very short: ${words} words`);
  else if (words < 200) (d += 0.2), signals.push(`short: ${words} words`);

  let teaser = 0;
  for (const [re, w, label] of TEASER) if (re.test(visible)) (teaser += w), signals.push(`teaser marker: ${label}`);
  d += Math.min(0.6, teaser);
  if (/(?:\.\.\.|…)\s*$/.test(visible)) (d += 0.15), signals.push("ends with an ellipsis");

  const have = contentStems(all);
  const cov = coverage(contentStems(promise), have);
  d += (1 - cov) * 0.45;
  signals.push(`promise keywords present: ${Math.round(cov * 100)}%`);

  const parts = promisedParts(promise);
  const missing = parts.filter((p) => coverage(p, have) < 0.5).length;
  if (missing) (d += (missing / parts.length) * 0.35), signals.push(`named parts missing: ${missing} of ${parts.length}`);

  const counted = COUNTED.exec(promise);
  const n = counted ? Number(counted[1]) : 0;
  if (n >= 3) {
    const k = visible.split("\n").filter((l) => LIST_ITEM.test(l)).length;
    if (k < n) (d += 0.5 * (1 - k / n)), signals.push(`list items: ${k} of ${n} promised`);
  }
  return { deficit: Math.min(1.3, d), signals };
}

export function deficitToProbabilities(d: number): PromiseProbabilities {
  const floor = 0.02;
  const no = Math.max(floor, clamp01((d - 0.35) * 1.3));
  const yes = Math.max(floor, clamp01(0.92 - d * 1.2));
  const partially = Math.max(floor, 1 - no - yes);
  const sum = no + yes + partially;
  return { yes: r3(yes / sum), partially: r3(partially / sum), no: r3(no / sum) };
}

// [mandate mentions the category, offer looks like it, label]
const FORBIDDEN: Array<[RegExp, RegExp, string]> = [
  [/subscription|recurring/i, /\bsubscri|\brecurring\b|\bper\s+month\b|\bmonthly\b|\bauto-?renew/i, "subscription or recurring charge"],
  [/software/i, /\bsoftware\b|\blicen[cs]e\s+key\b/i, "software"],
  [/physical/i, /\bshipping\b|\bshipped\b|\bhardcover\b|\bprinted\s+copy\b/i, "physical good"],
  [/donation|\btips?\b/i, /\bdonat|\btip\b/i, "donation or tip"],
  [/personal data/i, /\bpersonal\s+data\b|\bcontact\s+lists?\b|\bemail\s+lists?\b|\bleads?\b/i, "personal data"],
];

export class OfflineJudge implements Judge {
  readonly model = OFFLINE_MODEL;

  async judgeDelivery(input: DeliveryInput): Promise<JudgeResult> {
    const t0 = performance.now();
    const x = extractInspectableText(input.body, input.mimeType);
    const heuristic = heuristicInjection(x.text, x.hidden);
    // Hidden elements may hold real content (inactive tabs), so coverage counts them.
    const all = [x.text, ...x.hidden.filter((h) => h.kind === "hidden-element").map((h) => h.text)].join("\n");
    const { deficit, signals } = promiseDeficit(x.text, all, input.offer.promise);

    const words = x.text.split(/\s+/).filter(Boolean).length;
    const relevance = Math.min(1, coverage(contentStems(input.userQuestion), contentStems(all)) * 1.15);
    const usefulness = Math.round((1 + 4 * relevance * Math.min(1, words / 200)) * 100) / 100;

    return {
      verdict: { model: OFFLINE_MODEL, promise: deficitToProbabilities(deficit), injection: heuristic.score, usefulness },
      details: {
        model: OFFLINE_MODEL,
        latencyMs: Math.round(performance.now() - t0),
        heuristic,
        hidden: x.hidden,
        signals: [`promise deficit: ${deficit.toFixed(2)}`, ...signals],
      },
    };
  }

  async judgePurchase(input: PurchaseInput): Promise<PurchaseResult> {
    const t0 = performance.now();
    const p = input.proposed;
    const guard = offerInjection(p);
    const offerText = [p.title, p.promise, p.accessTerms].join("\n");
    const conflict = FORBIDDEN.find(([inMandate, inOffer]) => inMandate.test(input.mandateText) && inOffer.test(offerText));
    const task = withConcepts(contentStems(input.userTask));
    const offer = withConcepts(contentStems(`${p.title} ${p.promise}`));
    const fit = coverage(task, offer);
    // One shared topical word (not "business", "month", a year...) is enough to
    // call a purchase on-task; plain overlap then only fine-tunes the estimate.
    const topical = [...task].filter((w) => offer.has(w) && !GENERIC.has(w));
    const base = topical.length ? 0.62 + 0.33 * Math.min(1, fit * 1.6) : 0.1 + 0.85 * Math.min(1, fit * 1.6);
    const onTask = conflict ? 0.03 : base;
    const signals = conflict
      ? [`outside mandate: ${conflict[2]}`]
      : [`task keywords in offer: ${Math.round(fit * 100)}%`, ...(topical.length ? [`shared topic: ${topical.join(", ")}`] : [])];
    return {
      verdict: { model: OFFLINE_MODEL, onTask: r3(capOnTask(onTask, guard)) },
      details: { model: OFFLINE_MODEL, latencyMs: Math.round(performance.now() - t0), heuristic: guard, signals },
    };
  }
}
