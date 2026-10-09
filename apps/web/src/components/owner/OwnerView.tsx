"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ColDef } from "ag-grid-community";
import { DataGrid } from "@/components/grid/Grid";
import { ClaimOutcomeCell, MoneyCell, PurchaseStatusCell, RefundMoneyCell, SeqLinkCell } from "@/components/grid/renderers";
import { Icon } from "@/components/Icon";
import { ApiError, getJson, postJson } from "@/lib/api";
import { FUNDING_LABEL, FUNDING_SHORT, errorMessage, formatMinor, formatTime } from "@/lib/format";
import type { Mandate, OwnerListItem, OwnerPurchase, OwnerStats, PublisherListItem } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import "@/styles/dash.css";
import "@/styles/owner.css";

const STORE_KEY = "recourse.owner";

type Flash = { tone: "ok" | "warn" | "bad"; title: string; text?: string };

const FLAGS: Record<string, Flash> = {
  "vault=connected": { tone: "ok", title: "PayPal connected.", text: "The agent can now charge purchases above the balance threshold to this PayPal account, with no human present." },
  "vault=cancelled": { tone: "warn", title: "PayPal connection cancelled.", text: "Nothing was stored. Connect again when you are ready." },
  "topup=done": { tone: "ok", title: "Top-up received.", text: "The balance now covers cent-sized purchases without a PayPal fee per purchase." },
  "topup=cancelled": { tone: "warn", title: "Top-up cancelled.", text: "No money moved." },
};

const euros = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (v: string) => Math.round(Number.parseFloat(v.replace(",", ".")) * 100);

function readRemembered(): string | null {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function remember(id: string) {
  try {
    localStorage.setItem(STORE_KEY, id);
  } catch {
    // private mode: selection just does not persist
  }
}

export function OwnerView() {
  const [owners, setOwners] = useState<OwnerListItem[] | null>(null);
  const [publishers, setPublishers] = useState<PublisherListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [stats, setStats] = useState<OwnerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<"vault" | "topup" | null>(null);

  // ?vault=connected and friends: show once, then clean the URL.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const key of ["vault", "topup"]) {
      const v = q.get(key);
      const f = v ? FLAGS[`${key}=${v}`] : undefined;
      if (f) {
        setFlash(f);
        q.delete(key);
        const next = q.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
        break;
      }
    }
  }, []);

  const load = useCallback(
    async (forceId?: string) => {
      try {
        let list = owners;
        if (!list) {
          const [o, p] = await Promise.all([getJson<OwnerListItem[]>("v1/admin/owners"), getJson<PublisherListItem[]>("v1/admin/publishers").catch(() => [])]);
          list = o;
          setOwners(o);
          setPublishers(p);
        }
        const remembered = readRemembered();
        const id = forceId ?? selected ?? (remembered && list.some((o) => o.id === remembered) ? remembered : list.at(-1)?.id) ?? null;
        if (id && id !== selected) setSelected(id);
        if (id) setStats(await getJson<OwnerStats>(`v1/admin/owners/${id}`));
        setError(null);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [owners, selected],
  );

  usePoll(load, 6000);

  const choose = (id: string) => {
    remember(id);
    setSelected(id);
    setStats(null);
    void load(id);
  };

  const redirectTo = async (kind: "vault" | "topup") => {
    if (!selected) return;
    setBusy(kind);
    setFlash(null);
    try {
      remember(selected);
      const res =
        kind === "vault"
          ? await postJson<{ approveUrl: string }>(`v1/admin/owners/${selected}/vault`, {})
          : await postJson<{ approveUrl: string }>(`v1/admin/owners/${selected}/topups`, { amountMinor: 500 });
      window.location.assign(res.approveUrl);
    } catch (e) {
      setBusy(null);
      setFlash({ tone: "bad", title: kind === "vault" ? "Could not start the PayPal connection." : "Could not start the top-up.", text: errorMessage(e) });
    }
  };

  const publisherName = useMemo(() => new Map(publishers.map((p) => [p.id, p.name])), [publishers]);

  const cols = useMemo<ColDef<OwnerPurchase>[]>(
    () => [
      { field: "created_at", headerName: "Time", flex: 1.4, minWidth: 148, valueFormatter: (p) => formatTime(p.value as string), sort: "desc", cellClass: "cell-mono", filter: "agTextColumnFilter" },
      { field: "title", headerName: "Item", flex: 3, minWidth: 190, filter: "agTextColumnFilter", cellStyle: { fontWeight: 500 }, tooltipField: "title" },
      {
        field: "publisher_id",
        headerName: "Publisher",
        flex: 1.6,
        minWidth: 140,
        valueFormatter: (p) => (p.node?.rowPinned ? "" : (publisherName.get(String(p.value)) ?? String(p.value))),
        filterValueGetter: (p) => (p.data ? (publisherName.get(p.data.publisher_id) ?? p.data.publisher_id) : ""),
        filter: "agTextColumnFilter",
      },
      {
        field: "price_minor",
        headerName: "Price",
        flex: 1,
        minWidth: 84,
        type: "numericColumn",
        cellRenderer: MoneyCell,
        cellClass: "cell-mono",
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.price_minor / 100 : null),
      },
      {
        field: "funding",
        headerName: "Funding",
        flex: 1.3,
        minWidth: 118,
        valueFormatter: (p) => (p.node?.rowPinned ? "" : (FUNDING_SHORT[p.value as keyof typeof FUNDING_SHORT] ?? String(p.value))),
        filterValueGetter: (p) => (p.data ? FUNDING_LABEL[p.data.funding] : ""),
        filter: "agTextColumnFilter",
      },
      { field: "status", headerName: "Status", flex: 1.6, minWidth: 140, cellRenderer: PurchaseStatusCell, filter: "agTextColumnFilter" },
      {
        field: "refunded_minor",
        headerName: "Refunded",
        flex: 1.1,
        minWidth: 96,
        type: "numericColumn",
        cellRenderer: RefundMoneyCell,
        cellClass: "cell-mono",
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.refunded_minor / 100 : null),
      },
      { field: "claim_outcome", headerName: "Claim", flex: 1.6, minWidth: 140, cellRenderer: ClaimOutcomeCell, filter: "agTextColumnFilter" },
      { field: "receipt_seq", headerName: "Receipt", flex: 0.8, minWidth: 90, cellRenderer: SeqLinkCell, filter: "agNumberColumnFilter" },
    ],
    [publisherName],
  );

  const totals = useMemo<Partial<OwnerPurchase>[]>(() => {
    const rows = stats?.purchases ?? [];
    return [
      {
        title: `Totals, ${rows.length} purchases`,
        price_minor: rows.reduce((a, r) => a + r.price_minor, 0),
        refunded_minor: rows.reduce((a, r) => a + r.refunded_minor, 0),
      },
    ];
  }, [stats]);

  return (
    <div className="container dash">
      <div className="page-head">
        <p className="eyebrow">Owner</p>
        <h1>
          You set the rules. The agent <span className="hl hl--sky">spends inside them</span>.
        </h1>
        <p>Connect PayPal once, keep a small prepaid balance, and write the mandate. Recourse enforces it on the server too, so an agent that ignores its own policy still cannot overspend.</p>
      </div>

      {flash ? (
        <div className={`notice notice--${flash.tone}`} role={flash.tone === "bad" ? "alert" : "status"} style={{ marginBottom: 16 }}>
          <Icon name={flash.tone === "ok" ? "check" : "alert"} />
          <div>
            <strong>{flash.title}</strong>
            {flash.text ? <p>{flash.text}</p> : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="notice notice--bad" role="alert" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <div>
            <strong>Could not load the owner.</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <div className="dash__bar">
        <div role="group" aria-label="Owner" className="seg">
          {owners === null && !error ? <span className="muted">Loading owners…</span> : null}
          {owners?.length === 0 ? (
            <span className="muted">
              No owner yet. Run <code>pnpm demo:setup</code> to create one with an agent.
            </span>
          ) : null}
          {owners?.map((o) => (
            <button key={o.id} type="button" className="seg__btn" aria-pressed={o.id === selected} onClick={() => choose(o.id)}>
              <Icon name="user" size={16} /> {o.name}
              <span className="mono seg__id">{o.id.slice(-4)}</span>
            </button>
          ))}
        </div>
      </div>

      {stats ? (
        <>
          <section className="owner-grid" aria-label="Account">
            <div className="card owner-card">
              <p className="eyebrow">PayPal</p>
              <p className="owner-card__big">
                {stats.owner.paypalConnected ? (
                  <span className="chip chip--mint chip--lg">
                    <Icon name="check" size={14} /> Connected
                  </span>
                ) : (
                  <span className="chip chip--butter chip--lg">
                    <Icon name="stop" size={14} /> Not connected
                  </span>
                )}
              </p>
              <p className="muted owner-card__note">
                {stats.owner.paypalConnected
                  ? stats.owner.payerEmail
                    ? `Vaulted account ${stats.owner.payerEmail}.`
                    : "A vault token is on file."
                  : "Without it, only the prepaid balance can pay."}
              </p>
              <button type="button" className="btn btn--small" disabled={busy !== null} onClick={() => void redirectTo("vault")}>
                {busy === "vault" ? "Opening PayPal" : stats.owner.paypalConnected ? "Reconnect PayPal" : "Connect PayPal"} <Icon name="arrow" size={16} />
              </button>
            </div>

            <div className="card owner-card">
              <p className="eyebrow">Prepaid balance</p>
              <p className="owner-card__big mono tnum">{formatMinor(stats.balanceMinor)}</p>
              <p className="muted owner-card__note">Pays cent-sized purchases, where a PayPal fee per purchase would cost more than the content.</p>
              <button type="button" className="btn btn--small btn--secondary" disabled={busy !== null} onClick={() => void redirectTo("topup")}>
                {busy === "topup" ? "Opening PayPal" : "Top up 5 EUR"} <Icon name="arrow" size={16} />
              </button>
            </div>

            <div className="card owner-card">
              <p className="eyebrow">Spent this month</p>
              <p className="owner-card__big mono tnum">{formatMinor(stats.spentThisMonthMinor)}</p>
              {stats.mandate ? (
                <>
                  <div
                    className="budget"
                    role="meter"
                    aria-label="Monthly budget used"
                    aria-valuemin={0}
                    aria-valuemax={stats.mandate.budgetMonthlyMinor}
                    aria-valuenow={Math.min(stats.spentThisMonthMinor, stats.mandate.budgetMonthlyMinor)}
                    aria-valuetext={`${formatMinor(stats.spentThisMonthMinor)} of ${formatMinor(stats.mandate.budgetMonthlyMinor)}`}
                  >
                    <div className="budget__fill" style={{ width: `${Math.min(100, (stats.spentThisMonthMinor / Math.max(1, stats.mandate.budgetMonthlyMinor)) * 100)}%` }} />
                  </div>
                  <p className="muted owner-card__note">of {formatMinor(stats.mandate.budgetMonthlyMinor)} monthly budget</p>
                </>
              ) : (
                <p className="muted owner-card__note">No mandate yet, so the agent cannot buy anything.</p>
              )}
            </div>
          </section>

          <MandateForm key={stats.owner.id} ownerId={stats.owner.id} mandate={stats.mandate} publishers={publishers} onSaved={() => void load(stats.owner.id)} />

          <section className="dash__section" aria-labelledby="owner-purchases">
            <div className="dash__head">
              <h2 id="owner-purchases">Purchases by this owner&apos;s agents</h2>
            </div>
            <DataGrid<OwnerPurchase>
              rows={stats.purchases}
              columns={cols}
              getRowId={(p) => String(p.data.id ?? p.data.title ?? "pinned")}
              pinnedBottom={totals}
              label="Owner purchases"
              emptyText="No purchases yet. Run the console to create some."
            />
          </section>
        </>
      ) : owners?.length ? (
        <p className="muted">Loading account…</p>
      ) : null}
    </div>
  );
}

function MandateForm({ ownerId, mandate, publishers, onSaved }: { ownerId: string; mandate: Mandate | undefined; publishers: PublisherListItem[]; onSaved: () => void }) {
  const [budget, setBudget] = useState(euros(mandate?.budgetMonthlyMinor ?? 2000));
  const [max, setMax] = useState(euros(mandate?.maxPerPurchaseMinor ?? 500));
  const [onTask, setOnTask] = useState(Math.round((mandate?.onTaskMinProbability ?? 0.6) * 100));
  const [allowed, setAllowed] = useState<string[]>(mandate?.allowedPublishers ?? []);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Flash | null>(null);

  const budgetMinor = toMinor(budget);
  const maxMinor = toMinor(max);
  const invalid = !Number.isFinite(budgetMinor) || !Number.isFinite(maxMinor) || budgetMinor <= 0 || maxMinor <= 0 || maxMinor > budgetMinor;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    setSaving(true);
    setResult(null);
    try {
      const body = {
        currency: "EUR",
        budgetMonthlyMinor: budgetMinor,
        maxPerPurchaseMinor: maxMinor,
        onTaskMinProbability: onTask / 100,
        ...(allowed.length ? { allowedPublishers: allowed } : {}),
      };
      const res = await postJson<{ mandate: Mandate; hash: string }>(`v1/admin/owners/${ownerId}/mandate`, body);
      setResult({ tone: "ok", title: `Mandate saved as version ${res.mandate.version}.`, text: `Hash ${res.hash.slice(0, 16)}… goes into every receipt from now on.` });
      onSaved();
    } catch (err) {
      setResult({ tone: "bad", title: "Could not save the mandate.", text: err instanceof ApiError ? err.message : errorMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="dash__section" aria-labelledby="mandate-title">
      <div className="dash__head">
        <div>
          <h2 id="mandate-title">Mandate</h2>
          <p className="muted">
            {mandate ? (
              <>
                Version {mandate.version} is in force. Saving creates a new version; old receipts keep the hash of the version they were bought under.
              </>
            ) : (
              "No mandate yet."
            )}
          </p>
        </div>
      </div>
      <form className="card mandate" onSubmit={submit}>
        <div className="mandate__fields">
          <div className="field">
            <label htmlFor="budget">Monthly budget (EUR)</label>
            <input id="budget" className="input input--mono" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={!Number.isFinite(budgetMinor) || budgetMinor <= 0} />
            <p className="hint">All purchases in a calendar month, refunds not netted.</p>
          </div>
          <div className="field">
            <label htmlFor="max">Max per purchase (EUR)</label>
            <input id="max" className="input input--mono" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} aria-invalid={!Number.isFinite(maxMinor) || maxMinor <= 0 || maxMinor > budgetMinor} />
            <p className="hint">Offers above this are blocked before any money moves.</p>
          </div>
          <div className="field">
            <label htmlFor="ontask">
              On-task threshold: <span className="mono">{onTask}%</span>
            </label>
            <input id="ontask" type="range" min={0} max={100} step={5} value={onTask} onChange={(e) => setOnTask(Number(e.target.value))} className="range" aria-valuetext={`${onTask} percent`} />
            <p className="hint">The judge must be at least this sure a purchase serves the user&apos;s request.</p>
          </div>
        </div>
        <fieldset className="mandate__pubs">
          <legend className="field__label">Allowed publishers</legend>
          <p className="hint">Leave all unchecked to allow any registered publisher.</p>
          <div className="mandate__checks">
            {publishers.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={allowed.includes(p.id)} onChange={(e) => setAllowed((a) => (e.target.checked ? [...a, p.id] : a.filter((x) => x !== p.id)))} />
                {p.name}
              </label>
            ))}
            {publishers.length === 0 ? <span className="muted">No publishers registered.</span> : null}
          </div>
        </fieldset>
        <div className="mandate__actions">
          <button type="submit" className="btn" disabled={saving || invalid}>
            {saving ? "Saving" : "Save mandate"} <Icon name="arrow" size={18} />
          </button>
          {invalid ? <span className="hint">Enter amounts above zero; the per-purchase limit cannot exceed the budget.</span> : null}
          {mandate ? (
            <span className="muted mandate__current">
              Current: {formatMinor(mandate.budgetMonthlyMinor)} / {formatMinor(mandate.maxPerPurchaseMinor)} / {Math.round(mandate.onTaskMinProbability * 100)}%
            </span>
          ) : null}
        </div>
        {result ? (
          <div className={`notice notice--${result.tone}`} role={result.tone === "bad" ? "alert" : "status"}>
            <Icon name={result.tone === "ok" ? "check" : "alert"} />
            <div>
              <strong>{result.title}</strong>
              {result.text ? <p>{result.text}</p> : null}
            </div>
          </div>
        ) : null}
      </form>
    </section>
  );
}
