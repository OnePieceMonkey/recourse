import { Barcode } from "@/components/Barcode";
import { Stamp } from "@/components/Stamp";
import { formatMinor, formatMoney } from "@/lib/format";
import { liveTotals, outcomesOf, type Outcome, type RunState } from "@/lib/run";

const SHORT: Record<Outcome, { tone: string; text: string }> = {
  VERIFIED: { tone: "mint", text: "Verified" },
  REFUNDED: { tone: "sky", text: "Refunded" },
  PARTIAL_REFUND: { tone: "sky", text: "Partial refund" },
  QUARANTINED: { tone: "rose", text: "Quarantined" },
  BLOCKED: { tone: "butter", text: "Blocked by mandate" },
  REFUSED: { tone: "butter", text: "Refused before charge" },
  CLAIM_REJECTED: { tone: "mint", text: "Claim rejected" },
  CLAIM_CONTESTED: { tone: "butter", text: "Contested" },
  ERROR: { tone: "rose", text: "Error" },
};

function Leader({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`leader${strong ? " leader--strong" : ""}`}>
      <span className="leader__label">{label}</span>
      <span className="leader__dots" aria-hidden="true" />
      <span className="leader__value">{value}</span>
    </div>
  );
}

export function SummaryReceipt({ state }: { state: RunState }) {
  const totals = liveTotals(state);
  const currency = state.order.map((u) => state.sources[u]!.price.currency)[0] ?? "EUR";
  const net = totals.spentMinor - totals.refundedMinor;
  const final = state.status === "done" && !!state.summary;
  const seed = state.order
    .map((u) => state.sources[u]!.paid?.receipt.receipt.hash ?? "")
    .join("")
    .slice(0, 48);

  return (
    <section className="receipt summary" aria-labelledby="summary-title">
      <div className="receipt__head summary__head">
        <div>
          <p className="eyebrow">Recourse receipt</p>
          <h2 id="summary-title">Run summary</h2>
        </div>
        {final ? <Stamp kind="settled" label="Final" tilt={-4} animate /> : state.status === "running" || state.status === "connecting" ? <span className="live" aria-hidden="true">Live</span> : null}
      </div>
      <div className="receipt__tear" />
      <div className="receipt__body summary__body">
        {state.order.length ? (
          <ol className="items" aria-label="Sources">
            {state.order.map((url) => {
              const s = state.sources[url]!;
              const outs = outcomesOf(s);
              const refund = s.claim?.refund.minor ?? 0;
              const charged = !!s.paid;
              return (
                <li key={url} className="items__row">
                  <span className="items__idx mono">{String(s.index + 1).padStart(2, "0")}</span>
                  <span className="items__title">{s.title}</span>
                  <span className={`items__amt mono tnum${charged ? "" : " items__amt--off"}`}>{formatMoney(s.offer?.price ?? s.price)}</span>
                  <span className="items__status">
                    {outs.length ? outs.map((o) => <span key={o} className={`items__tag items__tag--${SHORT[o].tone}`}>{SHORT[o].text}</span>) : <span className="items__tag items__tag--idle">{charged ? "Verifying" : s.mandate || s.offer ? "In progress" : "Queued"}</span>}
                    {!charged && outs.includes("BLOCKED") ? <span className="items__note">not charged</span> : null}
                  </span>
                  {refund > 0 ? (
                    <>
                      <span className="items__idx" />
                      <span className="items__title items__title--refund">Refund</span>
                      <span className="items__amt items__amt--refund mono tnum">−{formatMinor(refund, s.price.currency)}</span>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted">Items appear here as the agent buys them.</p>
        )}

        <div className="summary__rule" />
        <Leader label="Spent" value={formatMinor(totals.spentMinor, currency)} />
        <Leader label="Refunded" value={`−${formatMinor(totals.refundedMinor, currency)}`} />
        <div className="summary__net">
          <span className="eyebrow">Net cost</span>
          <span className="summary__net-amt mono tnum">{formatMinor(net, currency)}</span>
        </div>
        <div className="summary__rule" />
        <Leader label="Blocked by mandate" value={String(totals.blocked)} />
        <Leader label="Refused before charge" value={String(totals.refused)} />
        <Leader label="Quarantined" value={String(totals.quarantined)} />
        <Leader label="Used in the answer" value={String(totals.used)} />
        <div className="summary__code">
          <Barcode seed={seed} />
          <p className="mono muted">Every line above is a receipt in the public log.</p>
        </div>
      </div>
      <div className="zigzag" aria-hidden="true" />
    </section>
  );
}
