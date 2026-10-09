import type { ReactNode } from "react";
import Link from "next/link";
import { Hash } from "@/components/Hash";
import { Icon } from "@/components/Icon";
import { ProbBar } from "@/components/ProbBar";
import { Stamp, type StampKind } from "@/components/Stamp";
import { FUNDING_LONG, formatBytes, formatMoney, reasonLabel, THRESHOLDS } from "@/lib/format";
import { outcomesOf, phaseOf, type Outcome, type Phase, type SourceState } from "@/lib/run";
import type { HiddenSegment } from "@/lib/types";

const OUTCOME_STAMP: Record<Outcome, StampKind> = {
  VERIFIED: "verified",
  REFUNDED: "refunded",
  PARTIAL_REFUND: "partial",
  QUARANTINED: "quarantined",
  BLOCKED: "blocked",
  REFUSED: "refused",
  CLAIM_REJECTED: "rejected",
  CLAIM_CONTESTED: "contested",
  ERROR: "error",
};

const WORKING: Record<Exclude<Phase, "queued" | "finished">, string> = {
  offer: "Requesting the signed offer",
  mandate: "Checking the mandate",
  payment: "Settling the payment",
  verify: "Verifying the delivery",
  claim: "Filing the claim with the receipt as evidence",
};

// Hidden text that has no business addressing a reader (see packages/judge HiddenKind).
const CONCEALED = new Set(["comment", "hidden-element", "markup", "invisible-chars", "tag-chars", "base64", "instruction-block"]);

function Step({ label, t, children }: { label: string; t: number | undefined; children: ReactNode }) {
  return (
    <div className="step rise">
      <div className="step__label">
        <span className="eyebrow">{label}</span>
        {t !== undefined ? <span className="step__t mono tnum">+{t.toFixed(1)}s</span> : null}
      </div>
      <div className="step__body">{children}</div>
    </div>
  );
}

function Working({ text }: { text: string }) {
  return (
    <div className="step step--working">
      <div className="step__label">
        <span className="eyebrow">Now</span>
      </div>
      <div className="step__body working">
        <span className="spinner" aria-hidden="true" />
        <span>{text}</span>
      </div>
    </div>
  );
}

export function SourceReceipt({ s, active, running }: { s: SourceState; active: boolean; running: boolean }) {
  const phase = phaseOf(s);
  const outcomes = outcomesOf(s);
  const queued = running && !active && phase === "offer" && !s.offer;
  const index = String(s.index + 1).padStart(2, "0");
  const concealed: HiddenSegment[] = (s.verified?.details?.hidden ?? []).filter((h) => CONCEALED.has(h.kind));

  return (
    <article className={`receipt src rise${queued ? " src--queued" : ""}${active ? " src--active" : ""}`} id={`src-${s.index}`} aria-label={`Source ${index}: ${s.title}`} data-phase={phase}>
      <header className="receipt__head">
        <div className="src__title">
          <div className="src__meta">
            <span className="num">{index}</span>
            <span className="eyebrow">{s.publisher || "Publisher"}</span>
          </div>
          <h3>{s.title}</h3>
          {s.reason ? <p className="src__reason muted">Agent&apos;s reason: {s.reason}</p> : null}
        </div>
        <div className="src__side">
          <span className="src__price mono tnum">{formatMoney(s.offer?.price ?? s.price)}</span>
          {outcomes.length ? (
            <div className="stamps">
              {outcomes.map((o, i) => (
                <Stamp key={o} kind={OUTCOME_STAMP[o]} animate tilt={i % 2 === 0 ? -4 : 3} />
              ))}
            </div>
          ) : null}
        </div>
      </header>

      {queued ? (
        <div className="receipt__body src__queued muted">Queued</div>
      ) : (
        <>
          <div className="receipt__tear" />
          <div className="receipt__body">
            {s.offer ? (
              <Step label="Offer" t={s.at.offer}>
                <blockquote className="promise">&ldquo;{s.offer.promise}&rdquo;</blockquote>
                <p className="facts">
                  <span>Signed by publisher</span>
                  <span className="mono">{s.offer.mimeType}</span>
                  <span className="mono">{formatBytes(s.offer.contentLength)}</span>
                  <span>
                    Committed <Hash value={s.offer.contentSha256} label="Committed SHA-256" />
                  </span>
                </p>
              </Step>
            ) : null}

            {s.mandate ? (
              <Step label="Mandate" t={s.at.mandate}>
                <div className="line">
                  {s.mandate.allow ? (
                    <span className="chip chip--mint">
                      <Icon name="check" size={13} /> Allowed
                    </span>
                  ) : (
                    <span className="chip chip--butter">
                      <Icon name="stop" size={13} /> Blocked
                    </span>
                  )}
                  {s.mandate.reasons.map((r) => (
                    <span key={r} className="chip chip--plain" title={r}>
                      {reasonLabel(r)}
                    </span>
                  ))}
                  {!s.mandate.allow ? <span className="muted">No money moved.</span> : null}
                </div>
                {s.mandate.onTask !== undefined ? (
                  <div className="bars">
                    <ProbBar label="On-task" value={s.mandate.onTask} tone="sky" />
                  </div>
                ) : null}
              </Step>
            ) : null}

            {s.paid ? (
              <Step label="Payment" t={s.at.payment}>
                <div className="line">
                  <span className={`chip ${s.paid.receipt.funding === "paypal_vault" ? "chip--sky" : "chip--plain"}`}>
                    <Icon name="wallet" size={13} /> {FUNDING_LONG[s.paid.receipt.funding]}
                  </span>
                  <span className="mono tnum">{formatMoney(s.paid.price)}</span>
                  <Link className="rcpt-link" href={`/verify?seq=${s.paid.receipt.receipt.seq}`} target="_blank" rel="noopener">
                    Receipt #{s.paid.receipt.receipt.seq} <Icon name="external" size={13} />
                  </Link>
                  {s.paid.receipt.paypalCaptureId ? (
                    <span className="muted">
                      capture <Hash value={s.paid.receipt.paypalCaptureId} head={6} tail={4} label="PayPal capture id" />
                    </span>
                  ) : null}
                </div>
              </Step>
            ) : null}

            {s.refused ? (
              <Step label="Payment" t={s.at.payment}>
                <div className="line">
                  <span className="chip chip--butter">
                    <Icon name="stop" size={13} /> Refused before charge
                  </span>
                  <span className="chip chip--plain">{s.refused.reason}</span>
                </div>
                {s.refused.message ? <p className="muted">{s.refused.message}</p> : null}
                <p className="muted">No money moved. The refusal is in the public log.</p>
              </Step>
            ) : null}

            {s.verified ? (
              <Step label="Verify" t={s.at.verify}>
                <div className={`line ${s.verified.hashMatches ? "" : "line--bad"}`}>
                  {s.verified.hashMatches ? (
                    <span className="chip chip--mint">
                      <Icon name="check" size={13} /> Hash matches
                    </span>
                  ) : (
                    <span className="chip chip--rose">
                      <Icon name="cross" size={13} /> Hash mismatch
                    </span>
                  )}
                  <span>
                    {s.verified.hashMatches
                      ? "SHA-256 of the delivered bytes equals the committed hash."
                      : "The bytes differ from the committed hash. The publisher changed the content after the offer."}
                  </span>
                </div>
                {s.verified.verdict.promise || s.verified.verdict.injection !== undefined ? (
                  <div className="bars">
                    {s.verified.verdict.promise ? (
                      <>
                        <ProbBar label="Promise: yes" value={s.verified.verdict.promise.yes} tone="mint" />
                        <ProbBar label="Partly" value={s.verified.verdict.promise.partially} tone="butter" threshold={THRESHOLDS.partially} thresholdLabel="Claim threshold: 70%" />
                        <ProbBar label="Promise: no" value={s.verified.verdict.promise.no} tone="rose" threshold={THRESHOLDS.notAsDescribed} thresholdLabel="Claim threshold: 70%" />
                      </>
                    ) : null}
                    {s.verified.verdict.injection !== undefined ? (
                      <ProbBar label="Injection" value={s.verified.verdict.injection} tone="rose" threshold={THRESHOLDS.injection} thresholdLabel="Quarantine threshold: 50%" />
                    ) : null}
                  </div>
                ) : s.verified.hashMatches ? (
                  <p className="muted">The judge returned no verdict.</p>
                ) : (
                  <p className="muted">Judge skipped: the bytes are not what was offered.</p>
                )}
                {concealed.length && s.verified.decision.reasons.includes("PROMPT_INJECTION") ? (
                  <div className="evidence">
                    <span className="eyebrow">Hidden text found{concealed[0]?.where ? ` (${concealed[0].where})` : ""}</span>
                    <p className="mono">{truncate(concealed[0]!.text, 220)}</p>
                  </div>
                ) : null}
                <p className="facts facts--small">
                  {s.verified.verdict.model !== "none" ? <span>Judge {s.verified.verdict.model}</span> : null}
                  {s.verified.details?.latencyMs ? <span className="mono tnum">{s.verified.details.latencyMs} ms</span> : null}
                  {s.verified.verdict.usefulness !== undefined ? <span>Usefulness {s.verified.verdict.usefulness.toFixed(1)} / 5</span> : null}
                </p>
              </Step>
            ) : null}

            {s.verified ? (
              <Step label="Decision" t={s.at.decision}>
                <div className="line">
                  {s.verified.decision.action === "claim" ? (
                    <span className="chip chip--rose">
                      <Icon name="refund" size={13} /> Claim {s.verified.decision.refundBps >= 10000 ? "full refund" : `${s.verified.decision.refundBps / 100}% refund`}
                    </span>
                  ) : s.verified.decision.quarantine ? (
                    <span className="chip chip--butter">
                      <Icon name="alert" size={13} /> Held back
                    </span>
                  ) : (
                    <span className="chip chip--mint">
                      <Icon name="check" size={13} /> Accept
                    </span>
                  )}
                  {s.verified.decision.reasons.map((r) => (
                    <span key={r} className="chip chip--plain" title={r}>
                      {reasonLabel(r)}
                    </span>
                  ))}
                  {s.verified.decision.quarantine ? <span className="chip chip--rose">Quarantined: never shown to the writing model</span> : null}
                </div>
              </Step>
            ) : null}

            {s.claim ? (
              <Step label="Claim" t={s.at.claim}>
                <div className="line">
                  {s.claim.outcome === "REFUND" ? (
                    <span className="chip chip--sky">
                      <Icon name="refund" size={13} /> Refund {formatMoney(s.claim.refund)}
                    </span>
                  ) : s.claim.outcome === "REJECT" ? (
                    <span className="chip chip--mint">
                      <Icon name="shield" size={13} /> Claim rejected
                    </span>
                  ) : (
                    <span className="chip chip--butter">
                      <Icon name="clock" size={13} /> Contested
                    </span>
                  )}
                  {s.claim.paypalRefundId ? (
                    <span className="muted">
                      PayPal refund <Hash value={s.claim.paypalRefundId} head={6} tail={4} label="PayPal refund id" />
                    </span>
                  ) : s.claim.outcome === "REFUND" ? (
                    <span className="muted">Credited back to the prepaid balance</span>
                  ) : null}
                  <Link className="rcpt-link" href={`/verify?seq=${s.claim.logSeq}`} target="_blank" rel="noopener">
                    Decision #{s.claim.logSeq} <Icon name="external" size={13} />
                  </Link>
                </div>
                {s.claim.reasons.length ? (
                  <p className="muted">Adjudicated: {s.claim.reasons.map(reasonLabel).join(", ")}.</p>
                ) : null}
              </Step>
            ) : null}

            {s.errors.map((m, i) => (
              <Step key={i} label="Error" t={undefined}>
                <p className="line line--bad">
                  <span className="chip chip--rose">
                    <Icon name="alert" size={13} /> {m}
                  </span>
                </p>
              </Step>
            ))}

            {running && active && phase !== "finished" && phase !== "queued" ? <Working text={`${WORKING[phase]}…`} /> : null}
          </div>
        </>
      )}
    </article>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
