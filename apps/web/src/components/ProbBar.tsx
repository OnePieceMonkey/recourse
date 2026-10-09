import { pct } from "@/lib/format";

// A probability from the decision model, drawn as a bar. The dashed tick marks the
// policy threshold: the model only supplies the number, code compares it to the tick.
export function ProbBar({
  label,
  value,
  tone = "sky",
  threshold,
  thresholdLabel,
}: {
  label: string;
  value: number | undefined;
  tone?: "mint" | "butter" | "rose" | "sky";
  threshold?: number;
  thresholdLabel?: string;
}) {
  const v = value === undefined ? 0 : Math.max(0, Math.min(1, value));
  const hit = threshold !== undefined && value !== undefined && value >= threshold;
  return (
    <div className={`pbar pbar--${tone}${hit ? " pbar--hit" : ""}`}>
      <span className="pbar__label">{label}</span>
      <div
        className="pbar__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(v * 100)}
        aria-valuetext={`${pct(value)}${threshold !== undefined ? `, claim threshold ${Math.round(threshold * 100)}%${hit ? ", reached" : ""}` : ""}`}
      >
        <div className="pbar__fill" style={{ width: `${v * 100}%` }} data-zero={v === 0} />
        {threshold !== undefined ? <span className="pbar__tick" style={{ left: `${threshold * 100}%` }} title={thresholdLabel ?? `Claim threshold ${Math.round(threshold * 100)}%`} /> : null}
      </div>
      <span className="pbar__val">{pct(value)}</span>
    </div>
  );
}
