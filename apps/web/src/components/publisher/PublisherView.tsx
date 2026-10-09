"use client";

import { useCallback, useMemo, useState } from "react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { DataGrid } from "@/components/grid/Grid";
import { ClaimOutcomeCell, EarningStatusCell, MoneyCell, PurchaseStatusCell, ReasonsCell, RefundMoneyCell, SeqLinkCell } from "@/components/grid/renderers";
import { Icon } from "@/components/Icon";
import { Hash } from "@/components/Hash";
import { getJson } from "@/lib/api";
import { FUNDING_LABEL, FUNDING_SHORT, errorMessage, formatMinor, formatTime } from "@/lib/format";
import type { ClaimRow, PublisherListItem, PublisherPurchase, PublisherStats } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import "@/styles/dash.css";

type PurchaseRow = PublisherPurchase;

const fundingLabel = (v: string) => FUNDING_LABEL[v as keyof typeof FUNDING_LABEL] ?? v;

export function PublisherView() {
  const [publishers, setPublishers] = useState<PublisherListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [stats, setStats] = useState<PublisherStats | null>(null);
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async (forceId?: string) => {
    try {
      const list = publishers ?? (await getJson<PublisherListItem[]>("v1/admin/publishers"));
      if (!publishers) setPublishers(list);
      const id = forceId ?? selected ?? new URLSearchParams(window.location.search).get("id") ?? list[0]?.id ?? null;
      if (id && id !== selected) setSelected(id);
      if (id) {
        const [s, c] = await Promise.all([getJson<PublisherStats>(`v1/admin/publishers/${id}`), getJson<ClaimRow[]>("v1/admin/claims")]);
        setStats(s);
        setClaims(c.filter((x) => x.publisher_id === id));
      }
      setError(null);
      setUpdated(new Date());
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [publishers, selected]);

  usePoll(load, 6000);

  const choose = (id: string) => {
    setSelected(id);
    setStats(null);
    setClaims(null);
    const u = new URL(window.location.href);
    u.searchParams.set("id", id);
    window.history.replaceState(null, "", u);
    void load(id);
  };

  const totals = useMemo(() => {
    const rows = stats?.purchases ?? [];
    const sum = (f: (r: PurchaseRow) => number) => rows.reduce((a, r) => a + f(r), 0);
    const pending = sum((r) => (r.earning_status === "PENDING" ? r.earning_minor : 0));
    const paid = sum((r) => (r.earning_status === "PAID" ? r.earning_minor : 0));
    return {
      sales: sum((r) => r.price_minor),
      refunded: sum((r) => r.refunded_minor),
      pending,
      paid,
      earned: pending + paid,
      rejected: (claims ?? []).filter((c) => c.outcome === "REJECT").length,
      refundedClaims: (claims ?? []).filter((c) => c.outcome === "REFUND").length,
    };
  }, [stats, claims]);

  const purchaseCols = useMemo<ColDef<PurchaseRow>[]>(
    () => [
      { field: "created_at", headerName: "Time", flex: 1.4, minWidth: 148, valueFormatter: (p) => formatTime(p.value as string), sort: "desc", cellClass: "cell-mono", filter: "agTextColumnFilter" },
      { field: "title", headerName: "Item", flex: 3, minWidth: 180, filter: "agTextColumnFilter", cellStyle: { fontWeight: 500 }, tooltipField: "title" },
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
        filterValueGetter: (p) => (p.data ? fundingLabel(p.data.funding) : ""),
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
      {
        field: "earning_minor",
        headerName: "Earning",
        flex: 1,
        minWidth: 90,
        type: "numericColumn",
        cellRenderer: MoneyCell,
        cellClass: "cell-mono",
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.earning_minor / 100 : null),
      },
      { field: "earning_status", headerName: "Payout", flex: 1.2, minWidth: 116, cellRenderer: EarningStatusCell, filter: "agTextColumnFilter" },
    ],
    [],
  );

  const purchaseTotals = useMemo<Partial<PurchaseRow>[]>(
    () => [{ title: `Totals, ${stats?.purchases.length ?? 0} purchases`, price_minor: totals.sales, refunded_minor: totals.refunded, earning_minor: totals.earned }],
    [stats, totals],
  );

  const claimCols = useMemo<ColDef<ClaimRow>[]>(
    () => [
      { field: "created_at", headerName: "Time", flex: 1.4, minWidth: 148, valueFormatter: (p) => formatTime(p.value as string), sort: "desc", cellClass: "cell-mono", filter: "agTextColumnFilter" },
      { field: "title", headerName: "Item", flex: 2.4, minWidth: 180, filter: "agTextColumnFilter", cellStyle: { fontWeight: 500 } },
      { field: "outcome", headerName: "Outcome", flex: 1.4, minWidth: 140, cellRenderer: ClaimOutcomeCell, filter: "agTextColumnFilter" },
      { field: "decided_reasons", headerName: "Decided on", flex: 2, minWidth: 200, cellRenderer: ReasonsCell, filter: "agTextColumnFilter", filterValueGetter: (p) => (p.data ? p.data.decided_reasons.map(String).join(" ") : "") },
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
        field: "refund_minor",
        headerName: "Refund",
        flex: 1,
        minWidth: 100,
        type: "numericColumn",
        cellRenderer: RefundMoneyCell,
        cellClass: "cell-mono",
        filter: "agNumberColumnFilter",
        filterValueGetter: (p) => (p.data ? p.data.refund_minor / 100 : null),
      },
      {
        field: "paypal_refund_id",
        headerName: "PayPal refund",
        flex: 1.4,
        minWidth: 150,
        filter: "agTextColumnFilter",
        cellRenderer: (p: ICellRendererParams) => (p.node.rowPinned ? null : p.value ? <Hash value={String(p.value)} head={6} tail={4} label="PayPal refund id" /> : <span className="muted">none</span>),
      },
      { field: "log_seq", headerName: "Log", flex: 0.7, minWidth: 90, cellRenderer: SeqLinkCell, filter: "agNumberColumnFilter" },
    ],
    [],
  );

  const claimTotals = useMemo<Partial<ClaimRow>[]>(
    () => [{ title: `Totals, ${claims?.length ?? 0} claims`, refund_minor: (claims ?? []).reduce((a, c) => a + c.refund_minor, 0) }],
    [claims],
  );

  const current = publishers?.find((p) => p.id === selected);

  return (
    <div className="container dash">
      <div className="page-head">
        <p className="eyebrow">Publisher dashboard</p>
        <h1>
          Honest publishers get paid. <span className="hl hl--mint">False claims fail</span> on the evidence.
        </h1>
        <p>Every purchase carries a signed offer and a signed delivery. Earnings stay pending for the protection window, so refunds never need a clawback.</p>
      </div>

      {error ? (
        <div className="notice notice--bad" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Could not load the dashboard.</strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      <div className="dash__bar">
        <div role="group" aria-label="Publisher" className="seg">
          {publishers === null ? <span className="muted">Loading publishers…</span> : null}
          {publishers?.length === 0 ? <span className="muted">No publishers registered yet. Start the publisher demo.</span> : null}
          {publishers?.map((p) => (
            <button key={p.id} type="button" className="seg__btn" aria-pressed={p.id === selected} onClick={() => choose(p.id)}>
              <Icon name="store" size={16} /> {p.name}
            </button>
          ))}
        </div>
        <div className="dash__meta">
          {current ? (
            <span className="muted">
              Signing key <Hash value={current.kid} head={40} tail={0} label="Key id" />
            </span>
          ) : null}
          <span className="muted mono">{updated ? `Updated ${updated.toLocaleTimeString("en-GB")}` : ""}</span>
          <button type="button" className="btn btn--secondary btn--small" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      <section className="totals" aria-label="Totals">
        <Total label="Earned" note="net of refunds" value={totals.earned} tone="mint" />
        <Total label="Refunded" note="back to buyers" value={totals.refunded} tone="sky" />
        <Total label="Pending" note="inside the protection window" value={totals.pending} tone="butter" />
        <Total label="Paid out" note="via PayPal Payouts" value={totals.paid} tone="plain" />
      </section>

      <section className="dash__section" aria-labelledby="purchases-title">
        <div className="dash__head">
          <h2 id="purchases-title">Purchases</h2>
          <div className="field dash__filter">
            <label htmlFor="pfilter" className="sr-only">
              Filter purchases
            </label>
            <input id="pfilter" className="input" placeholder="Filter every column" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        </div>
        <DataGrid<PurchaseRow>
          rows={stats ? stats.purchases : null}
          columns={purchaseCols}
          getRowId={(p) => String(p.data.id ?? p.data.title ?? "pinned")}
          pinnedBottom={purchaseTotals}
          quickFilter={filter}
          label="Purchases"
          emptyText="No purchases yet. Run the console to create some."
        />
      </section>

      <section className="dash__section" aria-labelledby="claims-title">
        <div className="dash__head">
          <div>
            <h2 id="claims-title">Claims against this publisher</h2>
            <p className="muted">
              {claims === null
                ? ""
                : `${totals.refundedClaims} paid, ${totals.rejected} rejected on the evidence. Recourse recomputes every hash and runs its own judge before it refunds.`}
            </p>
          </div>
        </div>
        <DataGrid<ClaimRow>
          rows={claims}
          columns={claimCols}
          getRowId={(p) => String(p.data.id ?? p.data.title ?? "pinned")}
          pinnedBottom={claimTotals}
          label="Claims"
          emptyText="No claims against this publisher."
          maxRows={8}
        />
      </section>
    </div>
  );
}

function Total({ label, note, value, tone }: { label: string; note: string; value: number; tone: "mint" | "sky" | "butter" | "plain" }) {
  return (
    <div className={`total total--${tone}`}>
      <p className="eyebrow">{label}</p>
      <p className="total__amt mono tnum">{formatMinor(value)}</p>
      <p className="total__note">{note}</p>
    </div>
  );
}
