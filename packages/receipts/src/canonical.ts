import { createHash } from "node:crypto";

// RFC 8785 (JCS): sorted keys, no whitespace, ECMAScript number serialization
// (which is what JSON.stringify does). Probabilities are floats; money is kept
// integral by the Zod schemas, not here.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalize: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalize: unsupported type ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
