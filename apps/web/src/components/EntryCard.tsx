import { Hash } from "./Hash";
import { Icon } from "./Icon";
import { fieldsOf, TYPE_LABEL } from "@/lib/entries";
import { formatTime } from "@/lib/format";
import type { LogEntry } from "@/lib/types";

// A log entry rendered like a till receipt.
export function EntryCard({ entry, tampered }: { entry: LogEntry; tampered?: string | undefined }) {
  const fields = fieldsOf(entry);
  return (
    <article className="receipt entry" aria-label={`Log entry ${entry.seq}`}>
      <header className="receipt__head">
        <div>
          <p className="eyebrow">Transparency log</p>
          <h3 className="entry__title">
            {TYPE_LABEL[entry.type] ?? entry.type} <span className="mono">#{entry.seq}</span>
          </h3>
          <p className="muted mono entry__at">{formatTime(entry.at)} · {entry.at}</p>
        </div>
        <span className="num" aria-hidden="true">
          <Icon name="chain" size={16} />
        </span>
      </header>
      <div className="receipt__tear" />
      <div className="receipt__body entry__body">
        {tampered ? (
          <p className="entry__tamper">
            <Icon name="alert" size={16} /> Tampered copy: {tampered}.
          </p>
        ) : null}
        <dl className="entry__fields">
          {fields.map((f) => (
            <div key={f.label} className="entry__row">
              <dt>{f.label}</dt>
              <dd className={f.kind === "money" ? "mono tnum entry__money" : f.kind === "mono" ? "mono" : undefined}>
                {f.kind === "hash" ? <Hash value={f.value} head={10} tail={6} label={f.label} /> : f.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="entry__seal">
          <div className="entry__row">
            <dt>Previous hash</dt>
            <dd>
              <Hash value={entry.prevHash} head={10} tail={6} label="Previous hash" />
            </dd>
          </div>
          <div className="entry__row">
            <dt>Entry hash</dt>
            <dd>
              <Hash value={entry.hash} head={10} tail={6} label="Entry hash" />
            </dd>
          </div>
          <div className="entry__row">
            <dt>Signature</dt>
            <dd>
              <Hash value={entry.sig} head={10} tail={6} label="Signature" /> <span className="muted mono">Ed25519, {entry.kid}</span>
            </dd>
          </div>
        </div>
        <details className="entry__raw">
          <summary>Raw JSON</summary>
          <pre className="mono">{JSON.stringify(entry, null, 2)}</pre>
        </details>
      </div>
    </article>
  );
}
