import { hashCanonical } from "./canonical";
import type { Signer, PublicJwk } from "./keys";
import { verifySignature } from "./keys";

export const GENESIS_HASH = "0".repeat(64);

export type LogEntryType = "receipt" | "settlement_refused" | "claim_decision" | "payout" | "anchor";

export interface LogEntryBody {
  seq: number;
  type: LogEntryType;
  prevHash: string;
  at: string; // ISO-8601 UTC
  data: Record<string, unknown>;
}

export interface LogEntry extends LogEntryBody {
  hash: string; // sha256 of canonical(body)
  sig: string; // Recourse signature over the body
  kid: string;
}

export function entryHash(body: LogEntryBody): string {
  return hashCanonical(body);
}

export function makeEntry(
  prev: Pick<LogEntry, "seq" | "hash"> | null,
  type: LogEntryType,
  data: Record<string, unknown>,
  signer: Signer,
  now: Date = new Date(),
): LogEntry {
  const body: LogEntryBody = {
    seq: prev ? prev.seq + 1 : 0,
    type,
    prevHash: prev ? prev.hash : GENESIS_HASH,
    at: now.toISOString(),
    data,
  };
  return { ...body, hash: entryHash(body), sig: signer.sign(body), kid: signer.kid };
}

export type ChainProblem =
  | { seq: number; problem: "bad_hash" }
  | { seq: number; problem: "bad_link" }
  | { seq: number; problem: "bad_signature" }
  | { seq: number; problem: "bad_sequence" };

// Verifies a contiguous slice. Pass the entry before the slice (or null for genesis).
export function verifyChain(
  entries: LogEntry[],
  publicJwk: PublicJwk,
  before: Pick<LogEntry, "seq" | "hash"> | null = null,
): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let prev = before;
  for (const e of entries) {
    const { hash, sig, kid: _kid, ...body } = e;
    const expectedSeq = prev ? prev.seq + 1 : 0;
    if (e.seq !== expectedSeq) problems.push({ seq: e.seq, problem: "bad_sequence" });
    if (e.prevHash !== (prev ? prev.hash : GENESIS_HASH)) problems.push({ seq: e.seq, problem: "bad_link" });
    if (entryHash(body) !== hash) problems.push({ seq: e.seq, problem: "bad_hash" });
    if (!verifySignature(publicJwk, body, sig)) problems.push({ seq: e.seq, problem: "bad_signature" });
    prev = e;
  }
  return problems;
}
