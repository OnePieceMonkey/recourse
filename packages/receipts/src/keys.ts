import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalize } from "./canonical";

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}
export interface PrivateJwk extends PublicJwk {
  d: string;
}

export interface Signer {
  kid: string;
  publicJwk: PublicJwk;
  sign(value: unknown): string;
}

export function generateSigner(kid: string): { signer: Signer; privateJwk: PrivateJwk } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" }) as unknown as PrivateJwk;
  return { signer: signerFromJwk(kid, privateJwk), privateJwk };
}

export function signerFromJwk(kid: string, jwk: PrivateJwk): Signer {
  const key: KeyObject = createPrivateKey({ key: jwk as any, format: "jwk" });
  const publicJwk: PublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
  return {
    kid,
    publicJwk,
    sign: (value) => cryptoSign(null, Buffer.from(canonicalize(value)), key).toString("base64url"),
  };
}

// Keys travel through env vars as base64url(JSON JWK) so they fit in one line.
export function signerFromEnv(kid: string, encoded: string): Signer {
  const jwk = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PrivateJwk;
  return signerFromJwk(kid, jwk);
}

export function encodeJwk(jwk: PrivateJwk | PublicJwk): string {
  return Buffer.from(JSON.stringify(jwk)).toString("base64url");
}

export function verifySignature(publicJwk: PublicJwk, value: unknown, signature: string): boolean {
  try {
    const key = createPublicKey({ key: publicJwk as any, format: "jwk" });
    return cryptoVerify(null, Buffer.from(canonicalize(value)), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
