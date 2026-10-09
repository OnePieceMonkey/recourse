import { env } from "./env";
import type { AnchorProof, LogEntry } from "./types";

export interface LogStats {
  entries: number;
  headSeq: number;
  headHash: string;
  purchases: number;
  spentMinor: number;
  refunds: number;
  refundedMinor: number;
  rejected: number;
  refused: number;
  quarantined: number;
  anchor: { status: "pending" | "confirmed" | "off" | "none"; block?: number; headSeq?: number };
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${env.facilitatorUrl}${path}`, { cache: "no-store", signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// Reads the public transparency log, the same data anyone can fetch, and counts it.
// Returns null when the facilitator cannot be reached or the log is empty.
export async function loadLogStats(): Promise<LogStats | null | "empty"> {
  try {
    const head = await json<LogEntry | null>("/v1/log/head");
    if (!head) return "empty";
    const all: LogEntry[] = [];
    for (let from = 0; from <= head.seq && all.length < 10_000; ) {
      const page = await json<{ entries: LogEntry[] }>(`/v1/log?from=${from}&to=${Math.min(head.seq, from + 499)}`);
      if (!page.entries.length) break;
      all.push(...page.entries);
      from = page.entries[page.entries.length - 1]!.seq + 1;
    }
    const anchors = await json<AnchorProof[]>("/v1/anchors").catch(() => [] as AnchorProof[]);
    let purchases = 0;
    let spentMinor = 0;
    let refunds = 0;
    let refundedMinor = 0;
    let rejected = 0;
    let refused = 0;
    let quarantined = 0;
    for (const e of all) {
      const d = e.data as Record<string, unknown>;
      if (e.type === "receipt") {
        purchases += 1;
        spentMinor += (d.price as { minor?: number } | undefined)?.minor ?? 0;
      } else if (e.type === "settlement_refused") {
        refused += 1;
      } else if (e.type === "claim_decision") {
        const decided = Array.isArray(d.decided) ? (d.decided as string[]) : [];
        if (d.outcome === "REFUND") {
          refunds += 1;
          refundedMinor += (d.refund as { minor?: number } | undefined)?.minor ?? 0;
          if (decided.includes("PROMPT_INJECTION") || decided.includes("HASH_MISMATCH")) quarantined += 1;
        } else if (d.outcome === "REJECT") {
          rejected += 1;
        }
      }
    }
    const last = anchors.at(-1);
    return {
      entries: head.seq + 1,
      headSeq: head.seq,
      headHash: head.hash,
      purchases,
      spentMinor,
      refunds,
      refundedMinor,
      rejected,
      refused,
      quarantined,
      anchor: !last ? { status: "none" } : last.method !== "opentimestamps" ? { status: "off" } : { status: last.status, ...(last.bitcoinBlock ? { block: last.bitcoinBlock } : {}), headSeq: last.headSeq },
    };
  } catch {
    return null;
  }
}
