"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Hash } from "@/components/Hash";
import { Icon } from "@/components/Icon";
import { getJson } from "@/lib/api";
import { summarize, TYPE_LABEL, TYPE_TONE } from "@/lib/entries";
import { errorMessage, formatTime, shortHash } from "@/lib/format";
import type { AnchorProof, KeyDoc, LogEntry, LogEntryType } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import "@/styles/log.css";

const PAGE = 100;

export function LogView() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [head, setHead] = useState<LogEntry | null | undefined>(undefined);
  const [anchors, setAnchors] = useState<AnchorProof[]>([]);
  const [key, setKey] = useState<KeyDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LogEntryType | "all">("all");
  const [limit, setLimit] = useState(PAGE);

  const load = useCallback(async () => {
    try {
      const h = await getJson<LogEntry | null>("v1/log/head");
      setHead(h);
      if (h) {
        const from = Math.max(0, h.seq - 499);
        const page = await getJson<{ entries: LogEntry[] }>(`v1/log?from=${from}&to=${h.seq}`);
        setEntries([...page.entries].reverse());
      } else {
        setEntries([]);
      }
      const [a, k] = await Promise.all([getJson<AnchorProof[]>("v1/anchors").catch(() => []), getJson<KeyDoc>(".well-known/recourse.json").catch(() => null)]);
      setAnchors(a);
      setKey(k);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  usePoll(load, 8000);

  const counts = useMemo(() => {
    const c: Partial<Record<LogEntryType, number>> = {};
    for (const e of entries ?? []) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  }, [entries]);

  const shown = useMemo(() => (entries ?? []).filter((e) => filter === "all" || e.type === filter), [entries, filter]);
  const anchoredSeq = useMemo(() => anchors.filter((a) => a.method === "opentimestamps").reduce((m, a) => Math.max(m, a.headSeq), -1), [anchors]);
  const latestAnchor = anchors.at(-1);

  const types = (Object.keys(TYPE_LABEL) as LogEntryType[]).filter((t) => counts[t]);

  return (
    <div className="container logx">
      <div className="page-head">
        <p className="eyebrow">Transparency log</p>
        <h1>
          Every receipt, claim and payout, <span className="hl hl--butter">in one public chain</span>.
        </h1>
        <p>Entries are signed by Recourse and hash-chained. The head is stamped into Bitcoin through OpenTimestamps. Pick any entry to verify it in your browser.</p>
      </div>

      {error ? (
        <div className="notice notice--bad" role="alert" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <div>
            <strong>Could not load the log.</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <section className="headbar" aria-label="Log head">
        <div>
          <p className="eyebrow">Head</p>
          <p className="headbar__big mono tnum">{head ? `#${head.seq}` : head === null ? "empty" : "…"}</p>
        </div>
        <div>
          <p className="eyebrow">Head hash</p>
          <p>{head ? <Hash value={head.hash} head={12} tail={8} label="Head hash" /> : <span className="muted">n/a</span>}</p>
        </div>
        <div>
          <p className="eyebrow">Signing key</p>
          <p className="mono">{key?.kid ?? "n/a"}</p>
        </div>
        <div>
          <p className="eyebrow">Bitcoin anchor</p>
          <p>
            {latestAnchor ? (
              latestAnchor.method !== "opentimestamps" ? (
                <span className="chip chip--plain">Off</span>
              ) : latestAnchor.status === "confirmed" ? (
                <span className="chip chip--mint">
                  <Icon name="check" size={12} /> Block {latestAnchor.bitcoinBlock?.toLocaleString("en") ?? "confirmed"}
                </span>
              ) : (
                <span className="chip chip--butter">
                  <Icon name="clock" size={12} /> Pending, head #{latestAnchor.headSeq}
                </span>
              )
            ) : (
              <span className="chip chip--plain">No anchor yet</span>
            )}
          </p>
        </div>
      </section>

      <div className="logx__bar" role="group" aria-label="Filter by entry type">
        <button type="button" className="seg__btn" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All <span className="mono seg__id">{entries?.length ?? 0}</span>
        </button>
        {types.map((t) => (
          <button key={t} type="button" className="seg__btn" aria-pressed={filter === t} onClick={() => setFilter(t)}>
            {TYPE_LABEL[t]} <span className="mono seg__id">{counts[t]}</span>
          </button>
        ))}
      </div>

      <section className="receipt tape" aria-label="Log entries">
        <div className="tape__head" aria-hidden="true">
          <span>#</span>
          <span>Type</span>
          <span>Summary</span>
          <span>Time</span>
          <span>Hash</span>
          <span />
        </div>
        <ol className="tape__list">
          {entries === null ? <li className="tape__empty muted">Loading the log…</li> : null}
          {entries && shown.length === 0 ? <li className="tape__empty muted">{entries.length === 0 ? "The log is empty. Run the console to create receipts." : "No entries of this type."}</li> : null}
          {shown.slice(0, limit).map((e) => (
            <li key={e.seq} className="tape__row">
              <span className="mono tnum tape__seq">
                #{e.seq}
                {anchoredSeq >= e.seq ? (
                  <span className="tape__anchor" title="Covered by an OpenTimestamps anchor">
                    <Icon name="chain" size={12} />
                    <span className="sr-only">anchored</span>
                  </span>
                ) : null}
              </span>
              <span className={`chip chip--${TYPE_TONE[e.type]} tape__type`}>{TYPE_LABEL[e.type] ?? e.type}</span>
              <span className="tape__sum">{summarize(e)}</span>
              <span className="mono tape__time">{formatTime(e.at)}</span>
              <span className="mono tape__hash" title={e.hash}>
                {shortHash(e.hash, 8, 4)}
              </span>
              <Link className="btn btn--small btn--secondary tape__verify" href={`/verify?seq=${e.seq}`}>
                Verify <Icon name="arrow" size={14} />
              </Link>
            </li>
          ))}
        </ol>
        {shown.length > limit ? (
          <div className="tape__more">
            <button type="button" className="btn btn--secondary btn--small" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, shown.length - limit)} more
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
