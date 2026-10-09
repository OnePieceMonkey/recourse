import { describe, expect, it } from "vitest";
import { adjudicate, checkMandate, decideClaim, refundAmountMinor, type Mandate, type Verdict } from "./index";

const mandate: Mandate = {
  version: 1,
  currency: "EUR",
  budgetMonthlyMinor: 2000,
  maxPerPurchaseMinor: 500,
  onTaskMinProbability: 0.6,
};

const verdict = (v: Partial<Verdict>): Verdict => ({ model: "test", ...v });
const honest = verdict({ promise: { yes: 0.9, partially: 0.08, no: 0.02 }, injection: 0.01 });
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("checkMandate", () => {
  it("allows a purchase within all limits", () => {
    expect(checkMandate({ publisherId: "p1", priceMinor: 490, currency: "EUR" }, mandate, { spentThisMonthMinor: 0 })).toEqual({
      allow: true,
      reasons: [],
    });
  });
  it("blocks the 49 EUR bundle a poisoned page asks for", () => {
    const d = checkMandate({ publisherId: "p1", priceMinor: 4900, currency: "EUR" }, mandate, { spentThisMonthMinor: 0 });
    expect(d.allow).toBe(false);
    expect(d.reasons).toEqual(["OVER_PER_PURCHASE_LIMIT", "OVER_MONTHLY_BUDGET"]);
  });
  it("counts what was already spent this month", () => {
    const d = checkMandate({ publisherId: "p1", priceMinor: 300, currency: "EUR" }, mandate, { spentThisMonthMinor: 1800 });
    expect(d.reasons).toEqual(["OVER_MONTHLY_BUDGET"]);
  });
  it("rejects other currencies and unlisted publishers", () => {
    const d = checkMandate(
      { publisherId: "p9", priceMinor: 100, currency: "USD" },
      { ...mandate, allowedPublishers: ["p1"] },
      { spentThisMonthMinor: 0 },
    );
    expect(d.reasons).toEqual(["CURRENCY_MISMATCH", "PUBLISHER_NOT_ALLOWED"]);
  });
  it("needs the judge's on-task probability when given", () => {
    const d = checkMandate({ publisherId: "p1", priceMinor: 100, currency: "EUR" }, mandate, { spentThisMonthMinor: 0 }, { onTask: 0.4 });
    expect(d.reasons).toEqual(["OFF_TASK"]);
  });
});

describe("decideClaim", () => {
  it("accepts an honest delivery", () => {
    expect(decideClaim({ hashMatches: true, verdict: honest })).toEqual({ action: "accept", refundBps: 0, quarantine: false, reasons: [] });
  });
  it("claims a hash mismatch in full and quarantines", () => {
    expect(decideClaim({ hashMatches: false })).toMatchObject({ action: "claim", refundBps: 10000, quarantine: true, reasons: ["HASH_MISMATCH"] });
  });
  it("quarantines and claims prompt injection", () => {
    const d = decideClaim({ hashMatches: true, verdict: { ...honest, injection: 0.93 } });
    expect(d).toMatchObject({ action: "claim", refundBps: 10000, quarantine: true, reasons: ["PROMPT_INJECTION"] });
  });
  it("claims not-as-described in full", () => {
    const d = decideClaim({ hashMatches: true, verdict: verdict({ promise: { yes: 0.05, partially: 0.15, no: 0.8 }, injection: 0 }) });
    expect(d).toMatchObject({ action: "claim", refundBps: 10000, quarantine: false, reasons: ["NOT_AS_DESCRIBED"] });
  });
  it("claims half for partially-as-described", () => {
    const d = decideClaim({ hashMatches: true, verdict: verdict({ promise: { yes: 0.1, partially: 0.75, no: 0.15 }, injection: 0 }) });
    expect(d).toMatchObject({ action: "claim", refundBps: 5000, reasons: ["PARTIALLY_AS_DESCRIBED"] });
  });
  it("does not claim without evidence, but quarantines unchecked content", () => {
    expect(decideClaim({ hashMatches: true })).toEqual({ action: "accept", refundBps: 0, quarantine: true, reasons: ["JUDGE_UNAVAILABLE"] });
  });
  it("does not claim on uncertain verdicts", () => {
    const d = decideClaim({ hashMatches: true, verdict: verdict({ promise: { yes: 0.4, partially: 0.3, no: 0.3 }, injection: 0.3 }) });
    expect(d.action).toBe("accept");
  });
});

describe("adjudicate", () => {
  const base = { refundBps: 10000, committedSha256: A, submittedSha256: A, withinProtectionWindow: true };

  it("refunds a provable bait-and-switch", () => {
    const r = adjudicate({ ...base, reasons: ["HASH_MISMATCH"], deliveredSha256: B, submittedSha256: B }, undefined);
    expect(r).toEqual({ outcome: "REFUND", refundBps: 10000, reasons: ["HASH_MISMATCH"] });
  });
  it("rejects a hash claim when the publisher delivered what it committed", () => {
    const r = adjudicate({ ...base, reasons: ["HASH_MISMATCH"], deliveredSha256: A, submittedSha256: B }, undefined);
    expect(r.outcome).toBe("REJECT");
  });
  it("rejects fabricated bytes that the publisher never signed", () => {
    const r = adjudicate({ ...base, reasons: ["HASH_MISMATCH"], deliveredSha256: B, submittedSha256: C }, undefined);
    expect(r).toMatchObject({ outcome: "REJECT", reasons: ["EVIDENCE_DOES_NOT_MATCH_COMMITMENT"] });
  });
  it("contests a hash claim without a valid delivery attestation", () => {
    expect(adjudicate({ ...base, reasons: ["HASH_MISMATCH"], submittedSha256: B }, undefined).outcome).toBe("CONTESTED");
  });
  it("refunds injection when the second opinion agrees", () => {
    const r = adjudicate({ ...base, reasons: ["PROMPT_INJECTION"] }, verdict({ injection: 0.88 }));
    expect(r).toEqual({ outcome: "REFUND", refundBps: 10000, reasons: ["PROMPT_INJECTION"] });
  });
  it("rejects a false claim against an honest source", () => {
    const r = adjudicate({ ...base, reasons: ["NOT_AS_DESCRIBED"] }, honest);
    expect(r).toEqual({ outcome: "REJECT", refundBps: 0, reasons: ["JUDGES_DISAGREE"] });
  });
  it("contests when the second opinion is uncertain", () => {
    const r = adjudicate({ ...base, reasons: ["NOT_AS_DESCRIBED"] }, verdict({ promise: { yes: 0.3, partially: 0.25, no: 0.45 } }));
    expect(r.outcome).toBe("CONTESTED");
  });
  it("rejects semantic claims about bytes other than the committed ones", () => {
    const r = adjudicate({ ...base, reasons: ["PROMPT_INJECTION"], submittedSha256: B }, verdict({ injection: 0.99 }));
    expect(r.reasons).toEqual(["EVIDENCE_DOES_NOT_MATCH_COMMITMENT"]);
  });
  it("rejects claims after the protection window", () => {
    expect(adjudicate({ ...base, reasons: ["PROMPT_INJECTION"], withinProtectionWindow: false }, verdict({ injection: 0.99 })).outcome).toBe("REJECT");
  });
  it("caps partial refunds at the policy rate", () => {
    const r = adjudicate({ ...base, reasons: ["PARTIALLY_AS_DESCRIBED"], refundBps: 9000 }, verdict({ promise: { yes: 0.2, partially: 0.6, no: 0.2 } }));
    expect(r).toEqual({ outcome: "REFUND", refundBps: 5000, reasons: ["PARTIALLY_AS_DESCRIBED"] });
  });
});

describe("refundAmountMinor", () => {
  it("rounds down to whole cents", () => {
    expect(refundAmountMinor(190, 10000)).toBe(190);
    expect(refundAmountMinor(5, 5000)).toBe(2);
  });
});
