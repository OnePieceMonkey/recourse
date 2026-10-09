import { describe, expect, it } from "vitest";
import {
  canonicalize,
  encodeJwk,
  generateSigner,
  makeEntry,
  sha256Hex,
  signerFromEnv,
  verifyChain,
  verifySignature,
  type LogEntry,
} from "./index";

describe("canonicalize", () => {
  it("sorts keys and drops undefined", () => {
    expect(canonicalize({ b: 1, a: { d: [1, "x"], c: null }, z: undefined })).toBe(
      '{"a":{"c":null,"d":[1,"x"]},"b":1}',
    );
  });
  it("keeps floats (probabilities) and rejects non-finite numbers", () => {
    expect(canonicalize({ p: 0.6 })).toBe('{"p":0.6}');
    expect(() => canonicalize({ p: Number.NaN })).toThrow(/non-finite/);
  });
  it("is stable for key order", () => {
    expect(sha256Hex(canonicalize({ a: 1, b: 2 }))).toBe(sha256Hex(canonicalize({ b: 2, a: 1 })));
  });
});

describe("signatures", () => {
  it("round-trips through the env encoding", () => {
    const { privateJwk } = generateSigner("k1");
    const signer = signerFromEnv("k1", encodeJwk(privateJwk));
    const sig = signer.sign({ offerId: "o1", price: 490 });
    expect(verifySignature(signer.publicJwk, { price: 490, offerId: "o1" }, sig)).toBe(true);
    expect(verifySignature(signer.publicJwk, { price: 491, offerId: "o1" }, sig)).toBe(false);
  });
});

describe("hash chain", () => {
  const { signer } = generateSigner("recourse-1");
  const build = (n: number) => {
    const out: LogEntry[] = [];
    for (let i = 0; i < n; i++) {
      out.push(makeEntry(out.at(-1) ?? null, "receipt", { i }, signer, new Date(Date.UTC(2026, 9, 9, 8, i))));
    }
    return out;
  };

  it("verifies an untouched chain", () => {
    expect(verifyChain(build(4), signer.publicJwk)).toEqual([]);
  });

  it("detects a rewritten entry", () => {
    const chain = build(4);
    chain[1] = { ...chain[1]!, data: { i: 99 } };
    const problems = verifyChain(chain, signer.publicJwk);
    expect(problems).toContainEqual({ seq: 1, problem: "bad_hash" });
    expect(problems).toContainEqual({ seq: 1, problem: "bad_signature" });
  });

  it("detects a removed entry", () => {
    const chain = build(4);
    chain.splice(2, 1);
    const problems = verifyChain(chain, signer.publicJwk);
    expect(problems).toContainEqual({ seq: 3, problem: "bad_sequence" });
    expect(problems).toContainEqual({ seq: 3, problem: "bad_link" });
  });

  it("verifies a slice given the preceding entry", () => {
    const chain = build(5);
    expect(verifyChain(chain.slice(3), signer.publicJwk, chain[2]!)).toEqual([]);
  });
});
