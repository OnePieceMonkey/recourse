import { canonicalize } from "./canonical";
import type { AnchorProof, KeyDoc, LogEntry, LogEntryBody } from "./types";

export const GENESIS_HASH = "0".repeat(64);

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bodyOf(e: LogEntry): LogEntryBody {
  const { hash: _h, sig: _s, kid: _k, ...body } = e;
  return body;
}

// null when this browser has no Ed25519 in WebCrypto (older Firefox/Chromium).
export async function importRecourseKey(doc: KeyDoc): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: doc.publicJwk.x }, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return null;
  }
}

export interface EntryResult {
  seq: number;
  type: string;
  hash: boolean;
  // null: the browser could not check Ed25519
  signature: boolean | null;
  link: boolean;
  sequence: boolean;
  expectedHash: string;
}

export async function verifyEntry(
  e: LogEntry,
  key: CryptoKey | null,
  before: Pick<LogEntry, "seq" | "hash"> | null,
): Promise<EntryResult> {
  const body = bodyOf(e);
  const canonical = canonicalize(body);
  const expectedHash = await sha256Hex(canonical);
  let signature: boolean | null = null;
  if (key) {
    try {
      signature = await crypto.subtle.verify({ name: "Ed25519" }, key, base64UrlToBytes(e.sig), enc.encode(canonical));
    } catch {
      signature = false;
    }
  }
  return {
    seq: e.seq,
    type: e.type,
    hash: expectedHash === e.hash,
    signature,
    link: e.prevHash === (before ? before.hash : GENESIS_HASH),
    sequence: e.seq === (before ? before.seq + 1 : 0),
    expectedHash,
  };
}

// Verifies a contiguous slice. `before` is the entry preceding the slice (null = genesis).
export async function verifySlice(
  entries: LogEntry[],
  key: CryptoKey | null,
  before: Pick<LogEntry, "seq" | "hash"> | null,
): Promise<EntryResult[]> {
  const out: EntryResult[] = [];
  let prev = before;
  for (const e of entries) {
    out.push(await verifyEntry(e, key, prev));
    prev = e;
  }
  return out;
}

export const entryOk = (r: EntryResult) => r.hash && r.link && r.sequence && r.signature !== false;

export function describeProblems(r: EntryResult): string[] {
  const p: string[] = [];
  if (!r.hash) p.push("hash does not match the body");
  if (r.signature === false) p.push("signature is invalid");
  if (!r.link) p.push("prevHash does not match the previous entry");
  if (!r.sequence) p.push("sequence number is out of order");
  return p;
}

export function anchorFor(anchors: AnchorProof[], seq: number): AnchorProof | undefined {
  // The earliest anchor whose head is at or after the entry covers it.
  return [...anchors].filter((a) => a.headSeq >= seq).sort((a, b) => a.headSeq - b.headSeq)[0];
}

export function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "application/octet-stream" });
}
