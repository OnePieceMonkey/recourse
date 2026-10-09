import type { ReasonCode, Verdict } from "@recourse/policy";

// Where text that a human reader does not see was found. "Concealed" kinds have no
// legitimate reason to address anyone; metadata kinds are routine (see heuristics).
export type HiddenKind =
  | "comment" // <!-- --> and the Markdown `[//]: # (...)` idiom
  | "hidden-element" // display:none, visibility:hidden, hidden, aria-hidden, font-size 0, same colour as background, off-screen
  | "markup" // tags addressed to models, e.g. <system>
  | "invisible-chars" // zero-width and bidi-control characters
  | "tag-chars" // Unicode tag characters ("ASCII smuggling"), decoded
  | "base64" // base64 blob that decodes to readable text
  | "instruction-block" // Markdown fence labelled as instructions
  | "meta" // <meta content>, <title>
  | "attribute" // alt, title, aria-label
  | "script-data" // JSON-LD and other non-JS script blocks
  | "link-title"; // Markdown link titles and reference definitions

export interface HiddenSegment {
  kind: HiddenKind;
  text: string;
  where?: string; // e.g. "div: display:none", "meta name=description"
  count?: number; // invisible-chars only
}

export interface Inspectable {
  text: string; // visible main text
  hidden: HiddenSegment[];
}

export type PromiseProbabilities = NonNullable<Verdict["promise"]>;

export interface Offer {
  seller: string;
  title: string;
  promise: string;
}

export interface DeliveryInput {
  userQuestion: string;
  offer: Offer;
  body: string;
  mimeType: string;
  url: string;
}

export interface PurchaseInput {
  mandateText: string;
  userTask: string;
  proposed: Offer & { accessTerms: string };
}

export interface HeuristicResult {
  score: number; // 0..1
  matches: string[];
}

export interface JudgeDetails {
  model: string;
  latencyMs: number;
  // Raw twin Choice answers (normal and reversed option order) and whether their argmax agrees.
  probabilities?: { forward: Record<string, number>; reversed: Record<string, number> };
  orderStable?: boolean;
  jevInjection?: number; // Jev's own noul, before max() with the heuristic
  usefulnessScore?: number; // raw 0-based Score
  heuristic: HeuristicResult;
  hidden?: HiddenSegment[];
  truncated?: boolean; // the text sent to the model was shortened
  signals?: string[]; // offline judge: why it decided what it decided
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: string; // set when the model call failed; the verdict then carries no model answers
}

export interface JudgeResult {
  verdict: Verdict;
  details: JudgeDetails;
}

export interface PurchaseResult {
  verdict: Pick<Verdict, "onTask" | "model">;
  details: JudgeDetails;
}

export interface Judge {
  readonly model: string;
  judgeDelivery(input: DeliveryInput): Promise<JudgeResult>;
  judgePurchase(input: PurchaseInput): Promise<PurchaseResult>;
}

// Structurally identical to apps/facilitator/src/service.ts `SecondOpinion`.
export type SecondOpinion = (input: {
  promise: string;
  title: string;
  mimeType: string;
  body: string;
  reasons: ReasonCode[];
}) => Promise<Verdict | undefined>;

// A verdict the policy can rely on: the model answered both the promise and the
// injection question. Anything less must be treated as "judge unavailable".
export function isCompleteVerdict(v: Verdict | undefined): v is Verdict & { promise: PromiseProbabilities; injection: number } {
  return !!v && v.promise !== undefined && v.injection !== undefined;
}
