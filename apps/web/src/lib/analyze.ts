import { getJson } from "./api";
import { canonicalize } from "./canonical";
import { tamper } from "./entries";
import { formatTime, shortHash } from "./format";
import type { AnchorProof, KeyDoc, LogEntry } from "./types";
import { anchorFor, describeProblems, entryOk, importRecourseKey, verifySlice } from "./verify";

export const MAX_CHAIN = 10_000;

export interface Bundle {
  seq: number;
  target: LogEntry;
  // Entries from seq-1 (when it exists) to the head, in order.
  chain: LogEntry[];
  hasBefore: boolean;
  head: LogEntry;
  key: KeyDoc;
  anchors: AnchorProof[];
  truncated: boolean;
}

export type CheckStatus = "pass" | "fail" | "note";
export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface Report {
  checks: Check[];
  ok: boolean;
  entry: LogEntry;
  headSeq: number;
  chainLength: number;
  anchor: AnchorProof | undefined;
  tampered: string | undefined;
  edSupported: boolean;
}

export async function fetchBundle(seq: number): Promise<Bundle> {
  const [key, head, anchors] = await Promise.all([
    getJson<KeyDoc>(".well-known/recourse.json"),
    getJson<LogEntry | null>("v1/log/head"),
    getJson<AnchorProof[]>("v1/anchors").catch(() => [] as AnchorProof[]),
  ]);
  if (!head) throw new Error("The log is empty. Run the console to create receipts first.");
  if (seq > head.seq) throw new Error(`There is no entry #${seq}. The log head is #${head.seq}.`);
  const target = await getJson<LogEntry>(`v1/log/${seq}`);
  const from = Math.max(0, seq - 1);
  const chain: LogEntry[] = [];
  let next = from;
  while (next <= head.seq && chain.length < MAX_CHAIN) {
    const to = Math.min(head.seq, next + 499);
    const page = await getJson<{ entries: LogEntry[] }>(`v1/log?from=${next}&to=${to}`);
    if (!page.entries.length) break;
    chain.push(...page.entries);
    next = page.entries[page.entries.length - 1]!.seq + 1;
  }
  return { seq, target, chain, hasBefore: seq > 0, head, key, anchors, truncated: chain[chain.length - 1]?.seq !== head.seq };
}

const differingKeys = (a: LogEntry, b: LogEntry): string[] => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => canonicalize((a as unknown as Record<string, unknown>)[k]) !== canonicalize((b as unknown as Record<string, unknown>)[k]));
};

export async function analyze(bundle: Bundle, opts: { pasted?: LogEntry | undefined; tamper: boolean }): Promise<Report> {
  const { seq, key: keyDoc, head, anchors } = bundle;
  const checks: Check[] = [];
  const push = (id: string, title: string, status: CheckStatus, detail: string) => checks.push({ id, title, status, detail });

  let entry: LogEntry = opts.pasted ?? bundle.target;
  let tampered: string | undefined;
  if (opts.tamper) {
    const t = tamper(entry);
    entry = t.entry;
    tampered = t.what;
  }

  // The slice to verify starts at the entry itself; the entry before it anchors the link.
  const before = bundle.hasBefore ? bundle.chain[0]! : null;
  const rest = bundle.chain.slice(bundle.hasBefore ? 2 : 1);
  const slice = [entry, ...rest];
  const cryptoKey = await importRecourseKey(keyDoc);
  const results = await verifySlice(slice, cryptoKey, before ? { seq: before.seq, hash: before.hash } : null);
  const first = results[0]!;

  // 1. served by the log
  const served = bundle.chain[bundle.hasBefore ? 1 : 0];
  push(
    "found",
    `Entry #${seq} is in the public log`,
    served && served.hash === bundle.target.hash ? "pass" : "fail",
    `${bundle.target.type} entry recorded ${formatTime(bundle.target.at)}. The log head is #${head.seq}.`,
  );

  // 2. pasted copy equals the log
  if (opts.pasted) {
    const diff = differingKeys(opts.pasted, bundle.target);
    push(
      "pasted",
      "The pasted receipt is identical to the log entry",
      diff.length === 0 ? "pass" : "fail",
      diff.length === 0 ? "Every field matches the public log." : `Differs from the log in: ${diff.join(", ")}.`,
    );
  }

  // 3. hash
  push(
    "hash",
    "Entry hash equals SHA-256 of the canonical body",
    first.hash ? "pass" : "fail",
    first.hash ? `${shortHash(first.expectedHash, 12, 8)} recomputed here, in your browser.` : `Recomputed ${shortHash(first.expectedHash, 12, 8)}, but the entry claims ${shortHash(entry.hash, 12, 8)}.`,
  );

  // 4. signature
  if (first.signature === null) {
    push("sig", "Recourse signature (Ed25519)", "note", "This browser cannot verify Ed25519 in WebCrypto. Use a current Chrome, Safari or Firefox.");
  } else {
    push(
      "sig",
      "Recourse signature is valid (Ed25519)",
      first.signature ? "pass" : "fail",
      first.signature ? `Signed by key ${keyDoc.kid}, checked against the public key at /.well-known/recourse.json.` : `The signature does not match the body for key ${keyDoc.kid}.`,
    );
  }

  // 5. link to the previous entry
  push(
    "link",
    before ? `Links to entry #${before.seq}` : "Genesis entry",
    first.link && first.sequence ? "pass" : "fail",
    before
      ? first.link
        ? `prevHash ${shortHash(entry.prevHash, 10, 6)} equals the hash of entry #${before.seq}.`
        : `prevHash ${shortHash(entry.prevHash, 10, 6)} does not match entry #${before.seq} (${shortHash(before.hash, 10, 6)}).`
      : first.link
        ? "prevHash is the all-zero genesis value."
        : "A first entry must carry the all-zero genesis prevHash.",
  );

  // 6. chain to head
  const bad = results.filter((r) => !entryOk(r));
  const last = slice[slice.length - 1]!;
  push(
    "chain",
    slice.length === 1 ? `Entry #${seq} is the head of the log` : `Chain from #${seq} to head #${last.seq} is intact`,
    bad.length === 0 ? "pass" : "fail",
    bad.length === 0
      ? slice.length === 1
        ? "Nothing has been appended after it yet."
        : `${slice.length} entries: every hash, signature and prevHash link verified.${bundle.truncated ? ` Stopped at ${MAX_CHAIN.toLocaleString("en")} entries.` : ""}`
      : `Entry #${bad[0]!.seq}: ${describeProblems(bad[0]!).join(", ")}.${bad.length > 1 ? ` ${bad.length - 1} more entries are affected.` : ""}`,
  );

  // 7. head consistency
  push(
    "head",
    "Head matches what the log serves now",
    last.hash === head.hash && last.seq === head.seq ? "pass" : bundle.truncated ? "note" : "fail",
    last.hash === head.hash ? `Head #${head.seq}, hash ${shortHash(head.hash, 10, 6)}.` : "The verified chain ends at a different hash than the log head.",
  );

  // 8. Bitcoin anchor
  const anchor = anchorFor(anchors, seq);
  if (!anchor) {
    push("anchor", "Bitcoin anchor", "note", "No OpenTimestamps anchor covers this entry yet. The head is stamped periodically; the next stamp will cover it.");
  } else {
    const at = [...(before ? [before] : []), ...slice].find((e) => e.seq === anchor.headSeq);
    const matches = at ? at.hash === anchor.headHash : undefined;
    if (matches === false) {
      push("anchor", `Anchor for head #${anchor.headSeq}`, "fail", `The anchored head hash ${shortHash(anchor.headHash, 10, 6)} is not the hash of entry #${anchor.headSeq} in this chain. The log was changed after it was anchored.`);
    } else if (anchor.method !== "opentimestamps") {
      push("anchor", `Anchor for head #${anchor.headSeq}`, "note", "Anchoring is switched off on this server, so there is no external timestamp.");
    } else if (anchor.status === "confirmed") {
      push(
        "anchor",
        `Anchored in Bitcoin${anchor.bitcoinBlock ? `, block ${anchor.bitcoinBlock.toLocaleString("en")}` : ""}`,
        "pass",
        `Head #${anchor.headSeq} (${shortHash(anchor.headHash, 10, 6)}) is committed to Bitcoin through OpenTimestamps, so this entry cannot be older than that block's time. Recourse reports the block; confirm it yourself with the .ots proof below.`,
      );
    } else {
      push(
        "anchor",
        `Anchor submitted for head #${anchor.headSeq}, awaiting Bitcoin`,
        "note",
        `Head ${shortHash(anchor.headHash, 10, 6)} was sent to the OpenTimestamps calendars. Confirmation in a Bitcoin block usually takes a few hours. The hash chain above does not depend on it.`,
      );
    }
  }

  return {
    checks,
    ok: checks.every((c) => c.status !== "fail"),
    entry,
    headSeq: head.seq,
    chainLength: slice.length,
    anchor,
    tampered,
    edSupported: cryptoKey !== null,
  };
}

// Accepts "12", "#12", or JSON: a log entry, a PaidReceipt, or a settlement envelope.
export function parseInput(raw: string): { seq: number; pasted?: LogEntry } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "Enter a log sequence number or paste a receipt." };
  const num = text.match(/^#?(\d{1,9})$/);
  if (num) return { seq: Number(num[1]) };
  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: "That is not valid JSON." };
    }
    const find = (v: unknown, depth = 0): LogEntry | undefined => {
      if (!v || typeof v !== "object" || depth > 5) return undefined;
      const o = v as Record<string, unknown>;
      if (typeof o.seq === "number" && typeof o.hash === "string" && typeof o.sig === "string" && typeof o.prevHash === "string" && o.data && typeof o.data === "object") return o as unknown as LogEntry;
      for (const k of ["receipt", "info", "extensions"]) {
        const r = find(o[k], depth + 1);
        if (r) return r;
      }
      for (const v2 of Object.values(o)) {
        const r = find(v2, depth + 1);
        if (r) return r;
      }
      return undefined;
    };
    const entry = find(json);
    if (!entry) return { error: "No receipt found in that JSON. Expected an object with seq, type, prevHash, at, data, hash, sig and kid." };
    return { seq: entry.seq, pasted: entry };
  }
  return { error: "Enter a number like 12, or paste a receipt as JSON." };
}
