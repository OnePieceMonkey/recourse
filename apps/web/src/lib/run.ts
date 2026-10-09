import type {
  Answer,
  CatalogEntry,
  ClaimDecision,
  ClaimResult,
  JudgeDetails,
  Money,
  OfferBody,
  PaidReceipt,
  ReasonCode,
  Verdict,
  AgentEvent,
} from "./types";

export type StepId = "offer" | "mandate" | "payment" | "verify" | "decision" | "claim";

export interface SourceState {
  url: string;
  index: number;
  title: string;
  publisher: string;
  price: Money;
  reason?: string;
  offer?: OfferBody;
  mandate?: { allow: boolean; reasons: ReasonCode[]; onTask?: number };
  paid?: { receipt: PaidReceipt; price: Money };
  refused?: { reason: string; message?: string };
  verified?: { hashMatches: boolean; verdict: Verdict; details: JudgeDetails | null; decision: ClaimDecision };
  claim?: ClaimResult;
  errors: string[];
  // Seconds since the run started, per step, for the little "+3.2s" marks.
  at: Partial<Record<StepId, number>>;
}

export interface Summary {
  spentMinor: number;
  refundedMinor: number;
  blocked: number;
  refused: number;
  quarantined: number;
  used: number;
}

export interface RunState {
  status: "idle" | "connecting" | "running" | "done" | "failed";
  question: string;
  writer?: string;
  judge?: string;
  catalog?: CatalogEntry[];
  planned: boolean;
  sources: Record<string, SourceState>;
  order: string[];
  answer?: Answer;
  summary?: Summary;
  error?: string;
  globalErrors: string[];
  stage: "catalog" | "plan" | "sources" | "answer" | "done";
}

export const initialRun: RunState = {
  status: "idle",
  question: "",
  planned: false,
  sources: {},
  order: [],
  globalErrors: [],
  stage: "catalog",
};

export type RunAction =
  | { kind: "begin"; question: string }
  | { kind: "event"; event: AgentEvent; t: number }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const blank = (url: string, index: number): SourceState => ({
  url,
  index,
  title: url,
  publisher: "",
  price: { currency: "EUR", minor: 0 },
  errors: [],
  at: {},
});

function patch(state: RunState, url: string, fn: (s: SourceState) => SourceState): RunState {
  const existing = state.sources[url];
  const base = existing ?? blank(url, state.order.length);
  const order = existing ? state.order : [...state.order, url];
  return { ...state, order, sources: { ...state.sources, [url]: fn(base) } };
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.kind) {
    case "begin":
      return { ...initialRun, status: "connecting", question: action.question };
    case "failed":
      return { ...state, status: "failed", error: action.message };
    case "done":
      return { ...state, status: state.status === "failed" ? "failed" : "done", stage: "done" };
    case "event": {
      const e = action.event;
      const t = Math.round(action.t * 10) / 10;
      switch (e.type) {
        case "start":
          return { ...state, status: "running", question: e.question, writer: e.writer, judge: e.judge, stage: "catalog" };
        case "catalog":
          return { ...state, catalog: e.items, stage: "plan" };
        case "plan": {
          const byUrl = new Map((state.catalog ?? []).map((c) => [c.url, c]));
          const sources: Record<string, SourceState> = {};
          const order: string[] = [];
          e.picks.forEach((p, i) => {
            const c = byUrl.get(p.url);
            sources[p.url] = { ...blank(p.url, i), title: p.title, publisher: c?.publisher ?? "", price: p.price, reason: p.reason };
            order.push(p.url);
          });
          return { ...state, sources, order, planned: true, stage: "sources" };
        }
        case "offer":
          return patch(state, e.url, (s) => ({ ...s, offer: e.offer, title: e.offer.title || s.title, price: e.offer.price, at: { ...s.at, offer: t } }));
        case "mandate":
          return patch(state, e.url, (s) => ({
            ...s,
            mandate: { allow: e.allow, reasons: e.reasons, ...(e.onTask !== undefined ? { onTask: e.onTask } : {}) },
            at: { ...s.at, mandate: t },
          }));
        case "paid":
          return patch(state, e.url, (s) => ({ ...s, paid: { receipt: e.receipt, price: e.price }, at: { ...s.at, payment: t } }));
        case "refused":
          return patch(state, e.url, (s) => ({
            ...s,
            refused: { reason: e.reason, ...(e.message ? { message: e.message } : {}) },
            at: { ...s.at, payment: t },
          }));
        case "verified":
          return patch(state, e.url, (s) => ({
            ...s,
            verified: { hashMatches: e.hashMatches, verdict: e.verdict, details: e.details, decision: e.decision },
            at: { ...s.at, verify: t, decision: t },
          }));
        case "claim":
          return patch(state, e.url, (s) => ({ ...s, claim: e.result, at: { ...s.at, claim: t } }));
        case "answer":
          return { ...state, answer: e.answer, stage: "answer" };
        case "summary": {
          const { type: _t, ...summary } = e;
          return { ...state, summary, stage: "done" };
        }
        case "error": {
          // The agent prefixes per-source errors with "<url>: ".
          const hit = state.order.find((u) => e.message.startsWith(`${u}: `));
          if (hit) return patch(state, hit, (s) => ({ ...s, errors: [...s.errors, e.message.slice(hit.length + 2)] }));
          return { ...state, globalErrors: [...state.globalErrors, e.message] };
        }
      }
    }
  }
  return state;
}

// ----- derived view of one source -----

export type Outcome =
  | "VERIFIED"
  | "REFUNDED"
  | "PARTIAL_REFUND"
  | "QUARANTINED"
  | "BLOCKED"
  | "REFUSED"
  | "CLAIM_REJECTED"
  | "CLAIM_CONTESTED"
  | "ERROR";

export function outcomesOf(s: SourceState): Outcome[] {
  const out: Outcome[] = [];
  if (s.mandate && !s.mandate.allow) return ["BLOCKED"];
  if (s.refused) return ["REFUSED"];
  if (s.verified?.decision.quarantine && s.verified.decision.action === "claim") out.push("QUARANTINED");
  if (s.claim) {
    if (s.claim.outcome === "REFUND") out.push(s.claim.refundBps >= 10000 ? "REFUNDED" : "PARTIAL_REFUND");
    else if (s.claim.outcome === "REJECT") out.push("CLAIM_REJECTED");
    else out.push("CLAIM_CONTESTED");
  } else if (s.verified && s.verified.decision.action === "accept" && !s.verified.decision.quarantine) {
    out.push("VERIFIED");
  }
  if (!out.length && s.errors.length) out.push("ERROR");
  return out;
}

export type Phase = "queued" | "offer" | "mandate" | "payment" | "verify" | "claim" | "finished";

export function phaseOf(s: SourceState): Phase {
  if (s.mandate && !s.mandate.allow) return "finished";
  if (s.refused) return "finished";
  if (s.errors.length) return "finished";
  if (s.claim) return "finished";
  if (s.verified) return s.verified.decision.action === "claim" ? "claim" : "finished";
  if (s.paid) return "verify";
  if (s.mandate?.allow) return "payment";
  if (s.offer) return "mandate";
  return "offer";
}

export interface Totals {
  spentMinor: number;
  refundedMinor: number;
  blocked: number;
  refused: number;
  quarantined: number;
  used: number;
  bought: number;
}

// Live totals from the events seen so far; the final "summary" event wins when it arrives.
export function liveTotals(state: RunState): Totals {
  let spent = 0;
  let refunded = 0;
  let blocked = 0;
  let refused = 0;
  let quarantined = 0;
  let used = 0;
  let bought = 0;
  for (const url of state.order) {
    const s = state.sources[url]!;
    if (s.paid) {
      spent += s.paid.price.minor;
      bought += 1;
    }
    if (s.claim) refunded += s.claim.refund.minor;
    if (s.mandate && !s.mandate.allow) blocked += 1;
    if (s.refused) refused += 1;
    if (s.verified?.decision.quarantine) quarantined += 1;
    if (s.verified && s.verified.decision.action === "accept" && !s.verified.decision.quarantine) used += 1;
  }
  const sm = state.summary;
  return sm ? { ...sm, bought } : { spentMinor: spent, refundedMinor: refunded, blocked, refused, quarantined, used, bought };
}
