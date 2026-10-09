import { DEFAULT_THRESHOLDS, type ClaimThresholds, type ReasonCode, type Verdict } from "./types";

export interface DeliveryCheck {
  hashMatches: boolean;
  verdict?: Verdict; // undefined when the judge call failed
}

export interface ClaimDecision {
  action: "accept" | "claim";
  refundBps: number; // 10000 = full refund
  quarantine: boolean; // content must not reach the generative model
  reasons: ReasonCode[];
}

const FULL = 10000;

// Agent side: decides whether a delivery is accepted, and if not, how much to claim.
export function decideClaim(check: DeliveryCheck, t: ClaimThresholds = DEFAULT_THRESHOLDS): ClaimDecision {
  if (!check.hashMatches) {
    // The bytes are not what the publisher committed to; we cannot know what they are.
    return { action: "claim", refundBps: FULL, quarantine: true, reasons: ["HASH_MISMATCH"] };
  }
  const v = check.verdict;
  if (!v) {
    // No judge, no claim: we only claim on evidence. Quarantine anyway, because an
    // unchecked page may carry injected instructions.
    return { action: "accept", refundBps: 0, quarantine: true, reasons: ["JUDGE_UNAVAILABLE"] };
  }
  const reasons: ReasonCode[] = [];
  let refundBps = 0;
  let quarantine = false;

  if ((v.injection ?? 0) >= t.injection) {
    reasons.push("PROMPT_INJECTION");
    refundBps = FULL;
    quarantine = true;
  }
  if (v.promise) {
    if (v.promise.no >= t.notAsDescribed) {
      reasons.push("NOT_AS_DESCRIBED");
      refundBps = FULL;
    } else if (v.promise.partially >= t.partially) {
      reasons.push("PARTIALLY_AS_DESCRIBED");
      refundBps = Math.max(refundBps, t.partialRefundBps);
    }
  }
  return reasons.length
    ? { action: "claim", refundBps, quarantine, reasons }
    : { action: "accept", refundBps: 0, quarantine: false, reasons: [] };
}

export interface ClaimEvidence {
  reasons: ReasonCode[];
  refundBps: number;
  committedSha256: string; // from the publisher-signed offer
  // From the publisher-signed delivery attestation the gate sends with the body.
  // Undefined when the attestation is missing or its signature does not verify.
  deliveredSha256?: string;
  submittedSha256: string; // hash of the bytes the agent submitted as evidence
  withinProtectionWindow: boolean;
}

export interface Adjudication {
  outcome: "REFUND" | "REJECT" | "CONTESTED";
  refundBps: number;
  reasons: ReasonCode[];
}

// Server side: same thresholds, independent second opinion (`ownVerdict`).
export function adjudicate(
  ev: ClaimEvidence,
  ownVerdict: Verdict | undefined,
  t: ClaimThresholds = DEFAULT_THRESHOLDS,
): Adjudication {
  if (!ev.withinProtectionWindow) {
    return { outcome: "REJECT", refundBps: 0, reasons: ["OUTSIDE_PROTECTION_WINDOW"] };
  }
  if (ev.reasons.includes("HASH_MISMATCH")) {
    // Arbitrary bytes prove nothing; only the publisher's own signature over what it
    // delivered does. Objective refund when the publisher signed a delivery that
    // differs from its signed offer and the agent holds exactly those bytes.
    if (!ev.deliveredSha256) {
      return { outcome: "CONTESTED", refundBps: 0, reasons: ["HASH_MISMATCH"] };
    }
    if (ev.deliveredSha256 === ev.committedSha256) {
      return { outcome: "REJECT", refundBps: 0, reasons: ["EVIDENCE_DOES_NOT_MATCH_COMMITMENT"] };
    }
    return ev.submittedSha256 === ev.deliveredSha256
      ? { outcome: "REFUND", refundBps: FULL, reasons: ["HASH_MISMATCH"] }
      : { outcome: "REJECT", refundBps: 0, reasons: ["EVIDENCE_DOES_NOT_MATCH_COMMITMENT"] };
  }
  // Semantic claims are only about the committed bytes.
  if (ev.submittedSha256 !== ev.committedSha256) {
    return { outcome: "REJECT", refundBps: 0, reasons: ["EVIDENCE_DOES_NOT_MATCH_COMMITMENT"] };
  }
  if (!ownVerdict) {
    return { outcome: "CONTESTED", refundBps: 0, reasons: ["JUDGE_UNAVAILABLE"] };
  }

  const confirmed: ReasonCode[] = [];
  let refundBps = 0;
  let clearlyDisagrees = true;

  if (ev.reasons.includes("PROMPT_INJECTION")) {
    const p = ownVerdict.injection ?? 0;
    if (p >= t.injection) {
      confirmed.push("PROMPT_INJECTION");
      refundBps = FULL;
    }
    if (p >= t.rejectBelow) clearlyDisagrees = false;
  }
  if (ev.reasons.includes("NOT_AS_DESCRIBED") && ownVerdict.promise) {
    const p = ownVerdict.promise.no;
    if (p >= t.notAsDescribed) {
      confirmed.push("NOT_AS_DESCRIBED");
      refundBps = FULL;
    }
    if (p >= t.rejectBelow) clearlyDisagrees = false;
  }
  if (ev.reasons.includes("PARTIALLY_AS_DESCRIBED") && ownVerdict.promise) {
    const p = ownVerdict.promise.partially + ownVerdict.promise.no;
    if (p >= t.partially) {
      confirmed.push("PARTIALLY_AS_DESCRIBED");
      refundBps = Math.max(refundBps, Math.min(ev.refundBps, t.partialRefundBps));
    }
    if (p >= t.rejectBelow) clearlyDisagrees = false;
  }

  if (confirmed.length) return { outcome: "REFUND", refundBps, reasons: confirmed };
  if (clearlyDisagrees) return { outcome: "REJECT", refundBps: 0, reasons: ["JUDGES_DISAGREE"] };
  return { outcome: "CONTESTED", refundBps: 0, reasons: ["JUDGES_DISAGREE"] };
}

export function refundAmountMinor(priceMinor: number, refundBps: number): number {
  return Math.floor((priceMinor * refundBps) / FULL);
}
