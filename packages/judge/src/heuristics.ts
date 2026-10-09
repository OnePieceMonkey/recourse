import { extractInspectableText } from "./extract";
import type { HeuristicResult, HiddenKind, HiddenSegment, Offer } from "./types";

// Deterministic detector for text addressed to AI agents. It complements Jev, whose
// answer the attacker-controlled page can move. Weights combine as a noisy OR.
//
// Calibration rules:
// - Concealed channels (comments, hidden elements, encodings) have no human reader,
//   so nothing there is "discussion": boosted, never discounted.
// - Visible text inside quotes or code, or right after "such as" / "like", is a
//   mention, not an instruction: discounted. So is visible text on a page that is
//   about security, except unquoted direct address ("AI agent: ...", "you are an
//   AI"), which articles for humans do not use.
// - Known trade-off: an attacker who quotes their own visible injection on a page
//   full of security vocabulary scores low here. Jev and the hidden channels remain.

interface Rule {
  id: string;
  w: number;
  re: RegExp;
  direct?: boolean; // addresses the model itself; not discounted for discussion pages
}

const AI = String.raw`(?:ai|a\.i\.|llms?|gpts?|chatgpt|claude|gemini|language\s+models?|chatbots?)`;
const AGENTISH = String.raw`(?:${AI}|assistants?|agents?|bots?|crawlers?|scrapers?)`;
const AI_PHRASE = String.raw`${AI}(?:\s+(?:agents?|assistants?|models?|systems?|crawlers?|tools?))?`;
const USER = String.raw`(?:the\s+|your\s+)?(?:user|human|owner|operator|principal)`;
const USER_POSS = String.raw`(?:the\s+)?(?:user|owner|principal|human)(?:['’]s|s)?`;
const NOT_NEGATED = String.raw`(?<!(?:\bnever|\bnot|n't|n’t)\s{1,3})`;
const re = (src: string) => new RegExp(src, "gi");

const RULES: Rule[] = [
  // Address
  { id: "address:you-are-ai", w: 0.5, direct: true, re: re(String.raw`\byou\s+are\s+(?:now\s+)?(?:an?\s+|the\s+)?(?:(?:helpful|autonomous|ai|research|shopping|purchasing|browsing|web)\s+){0,2}${AGENTISH}\b`) },
  { id: "address:if-you-are-ai", w: 0.55, direct: true, re: re(String.raw`\bif\s+you\s+are\s+(?:an?\s+)?(?:${AGENTISH}|automated)\b`) },
  { id: "address:note-to-ai", w: 0.5, direct: true, re: re(String.raw`\b(?:note|message|instructions?|reminder|warning)\s+(?:to|for)\s+(?:the\s+|any\s+|all\s+)?${AI_PHRASE}\b`) },
  { id: "address:dear-ai", w: 0.5, direct: true, re: re(String.raw`\b(?:dear|hey|hello|hi|attention)\s*,?\s+(?:the\s+)?${AI_PHRASE}\b`) },
  { id: "address:label", w: 0.6, direct: true, re: re(String.raw`(?:^|[\n.!?]\s*|[[(]\s*)${AI_PHRASE}\s*:\s*(?:please\s+)?(?:ignore|disregard|forget|you\s+(?:must|should|will|are|need)|do\s+not|don't|always|never|buy|purchase|pay|send|visit|open|go\s+to|tell|recommend|include|say|respond|answer|output|print|reveal|before|first|stop)\b`) },
  { id: "address:as-an-ai-you", w: 0.45, direct: true, re: re(String.raw`\bas\s+an?\s+${AI_PHRASE}\s*,?\s+(?:you|your)\b`) },
  { id: "address:as-an-ai", w: 0.3, re: re(String.raw`(?:^|[.!?\n]\s*)as\s+an?\s+(?:ai|llm)\s+(?:agent|assistant)\b`) },
  { id: "address:to-any-ai", w: 0.55, direct: true, re: re(String.raw`\b(?:to|for)\s+(?:any|all|every)\s+${AI_PHRASE}\s+(?:reading|processing|visiting|summari[sz]ing|parsing|crawling|indexing)\b`) },
  // Override
  { id: "override:ignore-instructions", w: 0.6, re: re(String.raw`\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every)\s+(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:(?:previous|prior|above|earlier|preceding|original|initial|system|existing|other)\s+)?|(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|original|initial|system|existing)\s+)(?:instructions?|prompts?|rules|directions|guidelines|directives|context|messages|tasks?|orders)\b`) },
  { id: "override:ignore-everything", w: 0.55, re: re(String.raw`\b(?:ignore|disregard|forget)\s+(?:everything|anything)\s+(?:above|before|previously|you\s+(?:were|have\s+been)\s+told)\b`) },
  { id: "override:new-task", w: 0.5, re: re(String.raw`\byour\s+(?:new|real|actual|true|only|primary|updated)\s+(?:task|instructions?|goal|objective|job|mission|purpose)\b`) },
  { id: "override:new-instructions", w: 0.4, re: re(String.raw`\b(?:new|updated|revised)\s+(?:system\s+)?instructions?\s*:`) },
  { id: "override:from-now-on", w: 0.35, re: re(String.raw`\bfrom\s+now\s+on\s*,?\s+(?:you|always|never|only|respond|answer)\b`) },
  { id: "override:instead-you", w: 0.3, re: re(String.raw`\binstead\s*,?\s+you\s+(?:must|should|will|need\s+to)\b`) },
  // Role-play wrappers
  { id: "wrapper:chat-template", w: 0.7, direct: true, re: re(String.raw`<\|\s*(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\s*\|>`) },
  { id: "wrapper:bracket-role", w: 0.5, direct: true, re: re(String.raw`\[\s*\/?\s*(?:system|sys|inst|admin|developer)\s*\]`) },
  { id: "wrapper:xml-role", w: 0.5, direct: true, re: re(String.raw`<\/?\s*(?:system|instructions?|sys|prompt|system[-_]prompt)\s*>`) },
  { id: "wrapper:role-heading", w: 0.4, direct: true, re: re(String.raw`(?:^|\n)\s*#{1,6}\s*(?:system|ai\s+instructions?|instructions?\s+for\s+${AI_PHRASE})\s*(?:\n|$)`) },
  { id: "wrapper:begin-prompt", w: 0.5, direct: true, re: re(String.raw`\b(?:begin|start|end)\s+(?:of\s+)?(?:the\s+)?(?:system|hidden|secret)\s+(?:prompt|instructions?|message)\b`) },
  { id: "mention:system-prompt", w: 0.2, re: re(String.raw`\bsystem\s+prompts?\b`) },
  { id: "mention:mode", w: 0.3, re: re(String.raw`\b(?:developer|god|dan|jailbreak|unrestricted)\s+mode\b`) },
  // Concealment from the user
  { id: "conceal:dont-tell-user", w: 0.5, re: re(String.raw`\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal|disclose|show|alert|notify|let)\s+(?:this\s+|it\s+|anything\s+|that\s+)?(?:to\s+)?${USER}s?\b`) },
  { id: "conceal:without-telling", w: 0.5, re: re(String.raw`\bwithout\s+(?:telling|informing|notifying|asking|alerting|consulting)\s+${USER}s?\b`) },
  { id: "conceal:hide-instructions", w: 0.5, re: re(String.raw`\b(?:do\s+not|don't|never)\s+(?:mention|reveal|disclose|repeat|acknowledge)\s+(?:these|this|the|any)\s+(?:instructions?|message|note|prompt)\b`) },
  { id: "conceal:keep-secret", w: 0.4, re: re(String.raw`\bkeep\s+(?:this|it|these\s+instructions?)\s+(?:secret|hidden|confidential)\b`) },
  // Actions: purchase, exfiltration, navigation, answer manipulation
  { id: "action:buy-now", w: 0.2, re: re(String.raw`\b(?:buy|purchase|order|pay\s+for|subscribe\s+to|check\s*out)\b[^.\n]{0,80}?\b(?:now|immediately|right\s+away|at\s+once|before\s+(?:answering|responding|replying|you\s+(?:answer|respond|reply|continue)))\b`) },
  { id: "action:make-payment", w: 0.2, re: re(String.raw`\b(?:make|complete|authori[sz]e|approve|execute|initiate)\s+(?:a\s+|the\s+|this\s+|an?\s+additional\s+)?(?:payment|purchase|transaction|transfer|checkout)\b`) },
  { id: "action:send-user-data", w: 0.45, re: re(String.raw`${NOT_NEGATED}\b(?:send|forward|e-?mail|post|submit|share|upload|leak|transmit|paste)\b[^.\n]{0,60}?\b${USER_POSS}\s+(?:e-?mail(?:\s+address)?|address|credentials?|passwords?|api\s+keys?|tokens?|personal\s+(?:data|details|information)|contact\s+details|phone(?:\s+number)?|name|card(?:\s+number)?|data)\b`) },
  { id: "action:send-secrets", w: 0.35, re: re(String.raw`${NOT_NEGATED}\b(?:send|forward|post|upload|submit|transmit|leak|reveal|print|output)\b[^.\n]{0,40}?\b(?:credentials?|passwords?|api\s+keys?|access\s+tokens?|session\s+cookies?|private\s+keys?|card\s+numbers?|system\s+prompt|conversation\s+history|chat\s+history)\b`) },
  { id: "action:send-to-address", w: 0.2, re: re(String.raw`\b(?:send|post|upload|submit|transmit|forward)\b[^.\n]{0,60}?\bto\s+(?:https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+)`) },
  { id: "action:visit-this-url", w: 0.25, re: re(String.raw`\b(?:visit|open|navigate\s+to|go\s+to|fetch|load|browse\s+to|follow|click)\s+(?:this|the\s+following|that)\s+(?:url|link|page|address|website|site)\b`) },
  { id: "action:visit-url", w: 0.1, re: re(String.raw`\b(?:visit|open|navigate\s+to|go\s+to|fetch|load|browse\s+to)\s*:?\s+https?:\/\/`) },
  { id: "action:tell-user", w: 0.4, re: re(String.raw`\b(?:tell|inform|convince|persuade|assure)\s+${USER}s?\s+(?:that|to)\b`) },
  { id: "action:in-your-answer", w: 0.25, re: re(String.raw`\b(?:in|into)\s+your\s+(?:answer|response|summary|output|final\s+answer)\b`) },
];

const CONCEALED: ReadonlySet<HiddenKind> = new Set([
  "comment", "hidden-element", "markup", "invisible-chars", "tag-chars", "base64", "instruction-block",
]);
const CONCEALED_BOOST = 1.5;
const DISCUSSION_FACTOR = 0.4;
const QUOTED_FACTOR = 0.2;
const MENTION_FACTOR = 0.3;
const MAX_WEIGHT = 0.95;
// A discounted mention (quoted, "such as ...") is listed but is not evidence on its own.
const MIN_EVIDENCE = 0.1;

const DISCUSSION = /\b(?:prompt\s+injections?|attackers?|security\s+researchers?|researchers?|vulnerabilit(?:y|ies)|jailbreaks?|owasp|red[-\s]team(?:ing)?|exploits?|malicious|threat\s+models?|defen[cs]es?|mitigations?|guardrails?)\b/gi;
// Code fences, quotes of all kinds, inline code, Markdown block quotes.
const QUOTED = /```[\s\S]{0,20000}?```|"[^"\n]{1,600}"|“[^”\n]{1,600}”|„[^“”\n]{1,600}[“”]|‘[^’\n]{1,600}’|«[^»\n]{1,600}»|`[^`\n]{1,600}`|(?<![\w’'])'[^'\n]{3,600}'(?!\w)|^>[^\n]*$/gm;
const MENTION_CUE = /(?:\bsuch\s+as|\blike|\be\.g\.|\bfor\s+(?:example|instance)|\bphrases?|\bsentences?|\bcommands?|\bsays?|\bsaid|\breads?|\bwrote|\bwrites?|\bcalled|\bknown\s+as|\bcontaining|\btyped?|\bexample)\s*[:,]?\s*$/i;

/** Pages about prompt injection use its vocabulary; real injections rarely do. */
function isDiscussion(text: string): boolean {
  const terms = new Set<string>();
  for (const m of text.matchAll(DISCUSSION)) terms.add(m[0].toLowerCase().replace(/s$/, ""));
  return terms.size >= 3;
}

function quoteRanges(s: string): Array<[number, number]> {
  return [...s.matchAll(QUOTED)].map((m) => [m.index!, m.index! + m[0].length]);
}

const snippet = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};
const round = (x: number) => Math.round(x * 1e4) / 1e4;

export function heuristicInjection(text: string, hidden: HiddenSegment[]): HeuristicResult {
  const discussion = isDiscussion(text);
  const best = new Map<string, { w: number; label: string }>();
  const hit = (key: string, w: number, label: string) => {
    const prev = best.get(key);
    if (!prev || prev.w < w) best.set(key, { w: Math.min(MAX_WEIGHT, w), label });
  };

  const scan = (s: string, channel: string, concealed: boolean) => {
    const quotes = concealed ? [] : quoteRanges(s);
    for (const rule of RULES) {
      for (const m of s.matchAll(rule.re)) {
        const at = m.index!;
        let f = concealed ? CONCEALED_BOOST : 1;
        if (!concealed) {
          const quoted = quotes.some(([a, b]) => at >= a && at < b);
          // Quoted direct address on a security page is the textbook example, not an attack.
          if (discussion && (!rule.direct || quoted)) f *= DISCUSSION_FACTOR;
          if (quoted) f *= QUOTED_FACTOR;
          else if (MENTION_CUE.test(s.slice(Math.max(0, at - 40), at))) f *= MENTION_FACTOR;
        }
        // One entry per rule and channel class: repetition is not extra evidence.
        hit(`${rule.id}|${concealed ? "concealed" : channel}`, rule.w * f, `${rule.id} [${channel}]: "${snippet(m[0])}"`);
      }
    }
  };

  scan(text, "visible", false);
  for (const h of hidden) {
    scan(h.text, h.kind, CONCEALED.has(h.kind));
    if (h.kind === "invisible-chars" && h.count !== undefined) {
      if (/U\+(?:202[A-E]|206[6-9])/.test(h.text)) hit("hiding:bidi", 0.2, "hiding [invisible-chars]: bidi-control characters");
      if (h.count >= 3) hit("hiding:zero-width", 0.15, `hiding [invisible-chars]: ${h.count} invisible characters`);
    }
    if (h.kind === "tag-chars") hit("hiding:tag-chars", 0.5, `hiding [tag-chars]: ${h.text.length} smuggled characters`);
  }

  const ranked = [...best.values()].sort((a, b) => b.w - a.w);
  const score = 1 - ranked.reduce((p, x) => (x.w >= MIN_EVIDENCE - 1e-9 ? p * (1 - x.w) : p), 1);
  return { score: round(Math.min(0.99, score)), matches: ranked.map((x) => x.label) };
}

// An offer whose own text addresses the agent is not a purchase to approve. The
// deterministic signal may lower a model's on-task probability, never raise it.
export const OFFER_INJECTION_GUARD = 0.5;

export function offerInjection(offer: Offer & { accessTerms: string }): HeuristicResult {
  const x = extractInspectableText([offer.seller, offer.title, offer.promise, offer.accessTerms].join("\n"), "text/plain");
  return heuristicInjection(x.text, x.hidden);
}

export function capOnTask(onTask: number, guard: HeuristicResult): number {
  return guard.score >= OFFER_INJECTION_GUARD ? Math.min(onTask, 1 - guard.score) : onTask;
}
