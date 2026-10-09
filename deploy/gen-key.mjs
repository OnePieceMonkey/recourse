// Prints a fresh Ed25519 private key as base64url(JWK) to stdout, nothing else.
import { generateKeyPairSync } from "node:crypto";
const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
process.stdout.write(Buffer.from(JSON.stringify(jwk)).toString("base64url"));
