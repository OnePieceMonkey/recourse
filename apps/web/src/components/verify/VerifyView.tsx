"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { EntryCard } from "@/components/EntryCard";
import { Icon } from "@/components/Icon";
import { Stamp } from "@/components/Stamp";
import { getJson } from "@/lib/api";
import { analyze, fetchBundle, parseInput, type Bundle, type Check, type Report } from "@/lib/analyze";
import { errorMessage, shortHash } from "@/lib/format";
import type { LogEntry } from "@/lib/types";
import { base64ToBlob } from "@/lib/verify";
import "@/styles/verify.css";

export function VerifyView() {
  const params = useSearchParams();
  const [input, setInput] = useState(params.get("seq") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [pasted, setPasted] = useState<LogEntry | undefined>(undefined);
  const [report, setReport] = useState<Report | null>(null);
  const [tampering, setTampering] = useState(false);
  const [runId, setRunId] = useState(0);
  const resultRef = useRef<HTMLDivElement>(null);

  const verify = useCallback(async (raw: string) => {
    const parsed = parseInput(raw);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    setTampering(false);
    try {
      const b = await fetchBundle(parsed.seq);
      setBundle(b);
      setPasted(parsed.pasted);
      setReport(await analyze(b, { pasted: parsed.pasted, tamper: false }));
      setRunId((n) => n + 1);
      const u = new URL(window.location.href);
      u.searchParams.set("seq", String(parsed.seq));
      window.history.replaceState(null, "", u);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
    } catch (e) {
      setBundle(null);
      setReport(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // /verify?seq=12 runs on arrival.
  useEffect(() => {
    const seq = params.get("seq");
    if (seq) void verify(seq);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTamper = async () => {
    if (!bundle) return;
    const next = !tampering;
    setTampering(next);
    setReport(await analyze(bundle, { pasted, tamper: next }));
    setRunId((n) => n + 1);
  };

  const latest = async () => {
    setBusy(true);
    setError(null);
    try {
      const head = await getJson<LogEntry | null>("v1/log/head");
      if (!head) throw new Error("The log is empty. Run the console to create receipts first.");
      setInput(String(head.seq));
      await verify(String(head.seq));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const failed = report?.checks.filter((c) => c.status === "fail").length ?? 0;

  return (
    <div className="container verify">
      <div className="page-head">
        <p className="eyebrow">Receipt verifier</p>
        <h1>
          Don&apos;t trust Recourse. <span className="hl hl--mint">Check the receipt</span> yourself.
        </h1>
        <p>Your browser fetches the entry, the chain up to the head, the public key and the anchors, then verifies every signature and hash itself.</p>
      </div>

      <form
        className="card verify__form"
        onSubmit={(e) => {
          e.preventDefault();
          void verify(input);
        }}
      >
        <div className="field">
          <label htmlFor="vin">Log sequence number, or a receipt as JSON</label>
          <textarea
            id="vin"
            className="textarea input--mono"
            rows={input.trim().startsWith("{") ? 8 : 2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'12\n\nor paste {"seq": 12, "type": "receipt", ...}'}
            spellCheck={false}
            aria-describedby="vhint"
          />
          <p id="vhint" className="hint">
            Pasting a receipt also checks that it is identical to what the public log serves. Edit one character to see it fail.
          </p>
        </div>
        <div className="verify__actions">
          <button className="btn" type="submit" disabled={busy || !input.trim()}>
            {busy ? "Verifying" : "Verify"} <Icon name="arrow" size={18} />
          </button>
          <button type="button" className="btn btn--secondary" onClick={() => void latest()} disabled={busy}>
            Verify the latest entry
          </button>
        </div>
      </form>

      {error ? (
        <div className="notice notice--bad verify__error" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Could not verify.</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <div ref={resultRef} className="verify__scroll" />
      {report && bundle ? (
        <div className="verify__result" key={runId}>
          <section className={`verdict ${report.ok ? "verdict--ok" : "verdict--bad"}`} aria-live="polite">
            <Stamp kind={report.ok ? "verified" : "invalid"} large animate tilt={-3} />
            <div>
              <h2>{report.ok ? `Entry #${report.entry.seq} is authentic and unmodified` : `Entry #${report.entry.seq} failed ${failed} check${failed === 1 ? "" : "s"}`}</h2>
              <p>
                {report.ok
                  ? report.edSupported
                    ? `Checked in your browser against key ${bundle.key.kid}.`
                    : "Hash chain checked. Your browser could not check the Ed25519 signature."
                  : report.tampered
                    ? `This is a tampered copy (${report.tampered}). The checks below show exactly what breaks.`
                    : "Do not rely on this receipt. The failing checks are marked below."}
              </p>
            </div>
            <div className="verdict__action">
              <button type="button" className="btn btn--small btn--secondary" onClick={() => void toggleTamper()}>
                {tampering ? "Restore the original" : "Change one detail and verify again"}
              </button>
              <p className="hint">Runs in your browser on a copy. Nothing is sent.</p>
            </div>
          </section>

          <div className="verify__grid">
            <section aria-labelledby="checks-title" className="verify__checks">
              <div className="why">
                <Icon name="lock" size={20} />
                <p>
                  <strong>Why it matters.</strong> Nobody, including Recourse, can rewrite this receipt: changing one byte breaks its hash and signature, and every later entry commits to it.
                </p>
              </div>

              <h2 id="checks-title" className="eyebrow">
                Checks
              </h2>
              <ol className="checks">
                {report.checks.map((c, i) => (
                  <CheckLine key={c.id} check={c} index={i} />
                ))}
              </ol>

              {report.anchor?.method === "opentimestamps" && report.anchor.proof ? (
                <div className="anchor-box">
                  <p className="eyebrow">Independent proof</p>
                  <p>
                    Download the OpenTimestamps proof for head <span className="mono">#{report.anchor.headSeq}</span> and check it without trusting Recourse:
                  </p>
                  <p className="mono anchor-box__cmd">ots verify -d {shortHash(report.anchor.headHash, 64, 0)} head-{report.anchor.headSeq}.ots</p>
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    onClick={() => {
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(base64ToBlob(report.anchor!.proof));
                      a.download = `head-${report.anchor!.headSeq}.ots`;
                      a.click();
                      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                    }}
                  >
                    <Icon name="download" size={16} /> Download .ots proof
                  </button>
                </div>
              ) : null}

            </section>

            <section aria-label="Receipt" className="verify__entry">
              <EntryCard entry={report.entry} tampered={report.tampered} />
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CheckLine({ check, index }: { check: Check; index: number }) {
  const icon = check.status === "pass" ? "check" : check.status === "fail" ? "cross" : "clock";
  const tag = check.status === "pass" ? "Pass" : check.status === "fail" ? "Fail" : "Note";
  return (
    <li className={`cl cl--${check.status}`} style={{ animationDelay: `${index * 110}ms` }}>
      <span className="cl__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="cl__text">
        <p className="cl__title">{check.title}</p>
        <p className="cl__detail">{check.detail}</p>
      </div>
      <span className="cl__tag">{tag}</span>
    </li>
  );
}
