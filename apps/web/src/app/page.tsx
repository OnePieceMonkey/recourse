import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { Stamp } from "@/components/Stamp";
import { formatMinor, shortHash } from "@/lib/format";
import { loadLogStats } from "@/lib/stats";
import "@/styles/home.css";

export const dynamic = "force-dynamic";

const STEPS: { n: string; icon: IconName; title: string; tone: string; body: string }[] = [
  {
    n: "01",
    icon: "hash",
    title: "The offer commits.",
    tone: "mint",
    body: "Every offer carries the SHA-256 of the content and a plain-language promise, signed by the publisher. Each purchase yields a signed receipt in a public, hash-chained log.",
  },
  {
    n: "02",
    icon: "eye",
    title: "The agent verifies.",
    tone: "butter",
    body: "Code compares the hash. A decision model, Jev, judges the promise and scans for prompt injection. Policy code decides. The model never moves money.",
  },
  {
    n: "03",
    icon: "refund",
    title: "PayPal refunds.",
    tone: "rose",
    body: "A bad delivery becomes a claim with the receipt as evidence. Recourse checks it again and refunds through PayPal. Honest publishers get the same evidence on their side.",
  },
];

export default async function Home() {
  const stats = await loadLogStats();
  const live = stats && stats !== "empty" ? stats : null;
  const num = (n: number | undefined) => (live && n !== undefined ? String(n) : "n/a");

  return (
    <>
      <section className="container hero">
        <div className="hero__copy">
          <p className="eyebrow">Buyer protection for AI agents, on PayPal rails</p>
          <h1>
            x402 payments have no recourse. <span className="hl hl--butter">Now they do.</span>
          </h1>
          <p className="hero__lede">
            An AI agent pays for a page. The page is empty, was swapped after the offer, or hides instructions aimed at the agent. The payment is final, and nobody can show what was promised.
          </p>
          <p className="hero__lede">Recourse makes every offer provable and every delivery checkable, so a bad purchase comes back as a refund.</p>
          <div className="hero__cta">
            <Link className="btn" href="/console">
              Open the console <Icon name="arrow" size={18} />
            </Link>
            <Link className="btn btn--secondary" href="/verify">
              Verify a receipt
            </Link>
          </div>
        </div>

        <div className="hero__art" aria-hidden="true">
          <div className="receipt demo">
            <div className="receipt__head">
              <div>
                <p className="eyebrow">QuickCheck Media</p>
                <p className="demo__title">Complete compliance checklist</p>
              </div>
              <span className="mono demo__price">€1.90</span>
            </div>
            <div className="receipt__tear" />
            <div className="receipt__body demo__body">
              <p className="demo__promise">&ldquo;The complete 25-point checklist, with a template for each step.&rdquo;</p>
              <div className="leader">
                <span className="leader__label">Committed SHA-256</span>
                <span className="leader__dots" />
                <span className="leader__value">9f2c…a41e</span>
              </div>
              <div className="leader">
                <span className="leader__label">Delivered</span>
                <span className="leader__dots" />
                <span className="leader__value">a 3-line teaser</span>
              </div>
              <div className="leader">
                <span className="leader__label">Promise kept, per Jev</span>
                <span className="leader__dots" />
                <span className="leader__value">3%</span>
              </div>
              <div className="leader">
                <span className="leader__label">Claim paid by PayPal</span>
                <span className="leader__dots" />
                <span className="leader__value">−€1.90</span>
              </div>
              <div className="demo__outcome" />
            </div>
            <div className="zigzag" />
          </div>
          <div className="demo__stamp">
            <Stamp kind="refunded" large tilt={-9} />
          </div>
        </div>
      </section>

      <section className="container section" aria-labelledby="how-title">
        <p className="eyebrow">How it works</p>
        <h2 id="how-title" className="section__title">
          Three steps. The model judges, <span className="hl hl--mint">code decides.</span>
        </h2>
        <div className="card-container steps">
          {STEPS.map((s) => (
            <article key={s.n} className={`card card--${s.tone} step-card`}>
              <div className="step-card__top">
                <span className="num">{s.n}</span>
                <span className="icon-box">
                  <Icon name={s.icon} />
                </span>
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="container section" aria-labelledby="live-title">
        <p className="eyebrow">Live from the public log</p>
        <h2 id="live-title" className="section__title">
          {live ? "What the log says right now." : stats === "empty" ? "The log is empty." : "The log is not reachable."}
        </h2>
        <div className="receipt livecard">
          <div className="livecard__grid">
            <Stat label="Purchases" value={num(live?.purchases)} note={live ? `${formatMinor(live.spentMinor)} spent` : undefined} />
            <Stat label="Refunds" value={num(live?.refunds)} note={live ? `${formatMinor(live.refundedMinor)} returned${live.rejected ? `, ${live.rejected} rejected` : ""}` : undefined} />
            <Stat label="Refused before charge" value={num(live?.refused)} note="bait-and-switch caught at settlement" />
            <Stat label="Quarantined" value={num(live?.quarantined)} note="never reached the writing model" />
          </div>
          <div className="receipt__tear" />
          <div className="livecard__foot">
            {live ? (
              <>
                <span>
                  <strong>{live.entries}</strong> entries, head <span className="mono">#{live.headSeq}</span> <span className="mono muted">{shortHash(live.headHash, 8, 6)}</span>
                </span>
                <span className="livecard__anchor">
                  <Icon name="chain" size={16} />
                  {live.anchor.status === "confirmed"
                    ? `Anchored in Bitcoin${live.anchor.block ? `, block ${live.anchor.block.toLocaleString("en")}` : ""}`
                    : live.anchor.status === "pending"
                      ? `Anchor pending, head #${live.anchor.headSeq}`
                      : live.anchor.status === "off"
                        ? "Anchoring is off"
                        : "No anchor yet"}
                </span>
                <Link href="/log" className="livecard__link">
                  Open the log <Icon name="arrow" size={14} />
                </Link>
              </>
            ) : stats === "empty" ? (
              <span>Run the console to create the first receipts.</span>
            ) : (
              <span>
                The facilitator is not running. Start the stack with <code>pnpm dev</code>.
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="container section" aria-label="Where to go next">
        <div className="gonext">
          <Link href="/console" className="gonext__item">
            <Icon name="receipt" /> <span>Console</span>
            <small>Run the agent</small>
          </Link>
          <Link href="/verify" className="gonext__item">
            <Icon name="shield" /> <span>Verifier</span>
            <small>Check a receipt</small>
          </Link>
          <Link href="/publisher" className="gonext__item">
            <Icon name="store" /> <span>Publisher</span>
            <small>Earnings, claims, payouts</small>
          </Link>
          <Link href="/owner" className="gonext__item">
            <Icon name="user" /> <span>Owner</span>
            <small>PayPal, balance, mandate</small>
          </Link>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="stat">
      <p className="eyebrow">{label}</p>
      <p className="stat__n mono tnum">{value}</p>
      {note ? <p className="stat__note">{note}</p> : null}
    </div>
  );
}
