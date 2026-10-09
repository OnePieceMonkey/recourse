"use client";

import Link from "next/link";
import type { ICellRendererParams } from "ag-grid-community";
import { Stamp, type StampKind } from "@/components/Stamp";
import { Hash } from "@/components/Hash";
import { formatMinor, reasonLabel } from "@/lib/format";
import type { ReasonCode } from "@/lib/types";

const PURCHASE_STATUS: Record<string, StampKind> = {
  SETTLED: "settled",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "partial",
};

export function PurchaseStatusCell(p: ICellRendererParams) {
  if (p.node.rowPinned || !p.value) return null;
  return <Stamp kind={PURCHASE_STATUS[String(p.value)] ?? "settled"} flat />;
}

export function ClaimOutcomeCell(p: ICellRendererParams) {
  if (p.node.rowPinned) return null;
  const v = p.value as string | null | undefined;
  if (!v) return <span className="muted">none</span>;
  if (v === "REFUND") return <Stamp kind="refunded" flat label="Claim paid" />;
  if (v === "REJECT") return <Stamp kind="rejected" flat label="Claim rejected" />;
  return <Stamp kind="contested" flat />;
}

export function EarningStatusCell(p: ICellRendererParams) {
  if (p.node.rowPinned || !p.value) return null;
  const v = String(p.value);
  return <Stamp kind={v === "PAID" ? "paid" : v === "CANCELLED" ? "cancelled" : "pending"} flat />;
}

export function ReasonsCell(p: ICellRendererParams) {
  const v = p.value as ReasonCode[] | null | undefined;
  if (p.node.rowPinned || !v?.length) return null;
  return (
    <span style={{ display: "flex", gap: 4, flexWrap: "nowrap" }}>
      {v.map((r) => (
        <span key={r} className="chip chip--plain" title={r}>
          {reasonLabel(r)}
        </span>
      ))}
    </span>
  );
}

export function HashCell(p: ICellRendererParams) {
  if (p.node.rowPinned || !p.value) return null;
  return <Hash value={String(p.value)} head={6} tail={4} />;
}

export function SeqLinkCell(p: ICellRendererParams) {
  if (p.node.rowPinned || p.value === null || p.value === undefined) return null;
  return (
    <Link className="cell-link" href={`/verify?seq=${p.value}`}>
      #{String(p.value)}
    </Link>
  );
}

export function MoneyCell(p: ICellRendererParams) {
  if (p.value === undefined || p.value === null) return null;
  const minor = Number(p.value);
  const cur = (p.data as { currency?: string } | undefined)?.currency ?? "EUR";
  return <span>{formatMinor(minor, cur)}</span>;
}

export function RefundMoneyCell(p: ICellRendererParams) {
  if (p.value === undefined || p.value === null) return null;
  const minor = Number(p.value);
  if (!minor) return <span className="muted">{p.node.rowPinned ? formatMinor(0) : "0.00"}</span>;
  const cur = (p.data as { currency?: string } | undefined)?.currency ?? "EUR";
  return <strong>−{formatMinor(minor, cur)}</strong>;
}
