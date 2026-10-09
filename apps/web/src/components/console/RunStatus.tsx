import { Icon } from "@/components/Icon";
import type { RunState } from "@/lib/run";
import { phaseOf } from "@/lib/run";

type StepState = "todo" | "doing" | "done";

export function RunStatus({ state, elapsed }: { state: RunState; elapsed: number }) {
  const finished = state.order.filter((u) => phaseOf(state.sources[u]!) === "finished").length;
  const total = state.order.length;
  const running = state.status === "running" || state.status === "connecting";
  const done = state.status === "done";

  const steps: { label: string; detail?: string; s: StepState }[] = [
    { label: "Read the catalog", s: state.catalog ? "done" : running ? "doing" : "todo", ...(state.catalog ? { detail: `${state.catalog.length} offers` } : {}) },
    { label: "Plan purchases", s: state.planned ? "done" : state.catalog && running ? "doing" : "todo", ...(state.planned ? { detail: `${total} picked` } : {}) },
    {
      label: "Buy and verify",
      s: !state.planned ? "todo" : finished >= total && total > 0 ? "done" : "doing",
      ...(state.planned ? { detail: `${finished} of ${total}` } : {}),
    },
    { label: "Write the answer", s: state.answer ? "done" : state.planned && finished >= total && running ? "doing" : "todo" },
  ];

  return (
    <section className="card runstatus" aria-labelledby="run-title">
      <div className="runstatus__head">
        <h2 id="run-title" className="eyebrow">
          Run
        </h2>
        <span className="mono tnum runstatus__time">{elapsed.toFixed(1)}s</span>
      </div>
      <ol className="pipe">
        {steps.map((st) => (
          <li key={st.label} className={`pipe__item pipe__item--${st.s}`}>
            <span className="pipe__icon" aria-hidden="true">
              {st.s === "done" ? <Icon name="check" size={14} /> : st.s === "doing" ? <span className="spinner spinner--sm" /> : null}
            </span>
            <span>
              {st.label}
              <span className="sr-only">{st.s === "done" ? " (done)" : st.s === "doing" ? " (in progress)" : " (waiting)"}</span>
            </span>
            {st.detail ? <span className="pipe__detail mono">{st.detail}</span> : null}
          </li>
        ))}
      </ol>
      {state.writer || state.judge ? (
        <dl className="models">
          {state.writer ? (
            <div>
              <dt>Writer</dt>
              <dd className="mono">{state.writer}</dd>
            </div>
          ) : null}
          {state.judge ? (
            <div>
              <dt>Judge</dt>
              <dd className="mono">{state.judge}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p className="muted runstatus__legend">
        {done ? "Run complete. " : ""}Dashed ticks on the bars mark policy thresholds. The model supplies the probabilities, policy code decides.
      </p>
    </section>
  );
}
