"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { SAMPLE_QUESTION, sampleRun } from "@/fixtures/agent-events";
import { formatMoney, errorMessage } from "@/lib/format";
import { initialRun, phaseOf, runReducer } from "@/lib/run";
import { readSse } from "@/lib/sse";
import type { AgentEvent, CatalogEntry } from "@/lib/types";
import { AnswerPanel } from "./AnswerPanel";
import { RunStatus } from "./RunStatus";
import { SourceReceipt } from "./SourceReceipt";
import { SummaryReceipt } from "./SummaryReceipt";
import "@/styles/console.css";

const DEFAULT_QUESTION = SAMPLE_QUESTION;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

export function Console() {
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [state, dispatch] = useReducer(runReducer, initialRun);
  const [shelf, setShelf] = useState<CatalogEntry[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const followRef = useRef(true);
  followRef.current = follow;

  const running = state.status === "connecting" || state.status === "running";

  // The shelf: what is for sale before the agent starts.
  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/catalog", { cache: "no-store", signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<CatalogEntry[]>) : Promise.reject(new Error(String(r.status)))))
      .then(setShelf)
      .catch(() => setShelf(null));
    return () => ctl.abort();
  }, []);

  // Elapsed timer while a run is open.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed((performance.now() - startedAt.current) / 1000), 100);
    return () => clearInterval(id);
  }, [running]);

  // Stop following when the reader scrolls on their own.
  useEffect(() => {
    const off = () => setFollow(false);
    window.addEventListener("wheel", off, { passive: true });
    window.addEventListener("touchmove", off, { passive: true });
    return () => {
      window.removeEventListener("wheel", off);
      window.removeEventListener("touchmove", off);
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(
    async (mode: "live" | "sample") => {
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      const q = (mode === "sample" ? SAMPLE_QUESTION : question).trim();
      if (!q) return;
      if (mode === "sample") setQuestion(SAMPLE_QUESTION);
      startedAt.current = performance.now();
      setElapsed(0);
      setFollow(true);
      dispatch({ kind: "begin", question: q });
      const t = () => (performance.now() - startedAt.current) / 1000;
      try {
        if (mode === "sample") {
          for (const step of sampleRun) {
            await sleep(step.after, ctl.signal);
            dispatch({ kind: "event", event: step.event, t: t() });
          }
        } else {
          const res = await fetch(`/api/agent/run?q=${encodeURIComponent(q)}`, { cache: "no-store", signal: ctl.signal });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { message?: string };
            throw new Error(body.message ?? `The agent answered HTTP ${res.status}.`);
          }
          for await (const msg of readSse(res)) {
            if (msg.event === "done") break;
            let ev: AgentEvent;
            try {
              ev = JSON.parse(msg.data) as AgentEvent;
            } catch {
              continue;
            }
            if (!ev || typeof ev !== "object") continue;
            if (!("type" in ev)) (ev as { type: string }).type = msg.event;
            dispatch({ kind: "event", event: ev, t: t() });
          }
        }
        setElapsed(t());
        dispatch({ kind: "done" });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setElapsed(t());
        dispatch({ kind: "failed", message: errorMessage(e) });
      }
    },
    [question],
  );

  // Follow the active card while a run is open.
  const activeIndex = state.order.findIndex((u) => phaseOf(state.sources[u]!) !== "finished");
  const answerShown = !!state.answer;
  useEffect(() => {
    if (!followRef.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const el = answerShown ? document.getElementById("answer-anchor") : activeIndex >= 0 ? document.getElementById(`src-${state.sources[state.order[activeIndex]!]!.index}`) : null;
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    // Re-run when the active card changes phase or the answer arrives.
  }, [activeIndex, answerShown, activeIndex >= 0 ? phaseOf(state.sources[state.order[activeIndex]!]!) : "", state.order.length]);

  const idle = state.status === "idle";
  const hasRun = !idle;
  const lastMessage =
    state.globalErrors.at(-1) ??
    (state.status === "failed" ? state.error : undefined);

  return (
    <div className="container console">
      <div className="page-head">
        <p className="eyebrow">Agent console</p>
        <h1>
          An agent buys research. <span className="hl hl--butter">Recourse</span> checks every delivery.
        </h1>
        <p>Ask a question. The agent picks paid sources, pays within its owner&apos;s mandate, verifies each delivery and claims a refund when it was cheated.</p>
      </div>

      <form
        className="ask card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!running) void start("live");
        }}
      >
        <div className="field">
          <label htmlFor="question">Question for the agent</label>
          <textarea id="question" className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} maxLength={500} disabled={running} />
        </div>
        <div className="ask__actions">
          <button className="btn" type="submit" disabled={running || !question.trim()}>
            {running ? "Running" : hasRun ? "Run again" : "Run the agent"} <Icon name="arrow" size={18} />
          </button>
          {running ? (
            <label className="toggle">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow the action
            </label>
          ) : (
            <button type="button" className="linklike" onClick={() => void start("sample")}>
              No backend running? Replay a recorded sample
            </button>
          )}
        </div>
      </form>

      <div aria-live="polite" className="sr-only" id="console-live">
        {running ? `Run in progress. ${state.order.length ? `${state.order.filter((u) => phaseOf(state.sources[u]!) === "finished").length} of ${state.order.length} sources done.` : ""}` : state.status === "done" ? "Run complete." : ""}
      </div>

      {lastMessage ? (
        <div className="notice notice--bad console__error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>{state.status === "failed" ? "The run could not finish." : "The agent reported a problem."}</strong>
            <p>{lastMessage}</p>
            {state.status === "failed" && state.order.length === 0 ? (
              <p className="hint">
                Start the stack with <code>pnpm dev</code>, or only the agent with <code>pnpm --filter @recourse/agent start serve</code>.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {idle || (state.status === "failed" && state.order.length === 0) ? (
        <Shelf items={shelf} />
      ) : (
        <div className="console__grid">
          <div className="console__main">
            {state.order.length === 0 && running ? (
              <div className="card waiting" role="status">
                <span className="spinner" aria-hidden="true" />
                <p>{state.catalog ? "The writer model is choosing sources." : state.status === "connecting" ? "Connecting to the agent." : "The agent is reading the catalog."}</p>
              </div>
            ) : null}
            {state.order.map((url, i) => (
              <SourceReceipt key={url} s={state.sources[url]!} active={i === activeIndex} running={running} />
            ))}
            <div id="answer-anchor" />
            {state.answer ? <AnswerPanel answer={state.answer} state={state} /> : null}
          </div>
          <aside className="console__side" aria-label="Run overview">
            <RunStatus state={state} elapsed={elapsed} />
            <SummaryReceipt state={state} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Shelf({ items }: { items: CatalogEntry[] | null }) {
  if (!items) {
    return (
      <section className="card shelf shelf--empty">
        <p className="eyebrow">On the shelf</p>
        <p className="muted">The publisher demo is not reachable, so the catalog is empty. The agent needs it to shop.</p>
      </section>
    );
  }
  return (
    <section className="receipt shelf" aria-labelledby="shelf-title">
      <div className="receipt__head">
        <div>
          <p className="eyebrow">On the shelf</p>
          <h2 id="shelf-title">{items.length} offers from {new Set(items.map((i) => i.publisherId)).size} publishers</h2>
        </div>
        <span className="muted shelf__hint">Each offer commits to a SHA-256 and a promise.</span>
      </div>
      <div className="receipt__tear" />
      <ul className="shelf__list">
        {items.map((i) => (
          <li key={i.url} className="shelf__row">
            <div>
              <p className="eyebrow">{i.publisher}</p>
              <p className="shelf__title">{i.title}</p>
              <p className="muted shelf__promise">{i.promise}</p>
            </div>
            <span className="mono tnum shelf__price">{formatMoney(i.price)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
