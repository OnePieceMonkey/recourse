# `auth-capture` on PayPal: binding specification

Status: draft, implemented in this repository. Follows the structure of x402's
`scheme_impl_template.md`. Network ids: `paypal:sandbox`, `paypal:live` (not used here).

## 1. Summary

This binding runs x402 V2's `auth-capture` scheme over PayPal instead of an on-chain escrow.
The facilitator (Recourse) is the merchant of record. Funds come from a PayPal wallet the payer
vaulted once (Vault v3) or from a prepaid balance topped up via PayPal checkout. The binding adds
two artefacts that `auth-capture` on EVM does not need but buyer protection for content does:

- a **publisher-signed offer** that commits to the SHA-256 of the content and a plain-language promise;
- a **publisher-signed delivery attestation** with the SHA-256 of the bytes actually sent.

Payment flow: `authorization` only (verify → resource → settle → respond). Refunds and disputes
are out-of-band lifecycle operations (allowed by the `auth-capture` overview): they are decided by
the facilitator's adjudication and executed with PayPal's Refund and Disputes APIs.

## 2. `PaymentRequirements`

| Field | Value |
|---|---|
| `scheme` | `"auth-capture"` |
| `network` | `"paypal:sandbox"` |
| `amount` | price in minor units of `asset`, decimal string (`"190"` = 1.90 EUR) |
| `asset` | ISO 4217 code, e.g. `"EUR"` |
| `payTo` | `"merchant"` (the facilitator settles and pays publishers out) |
| `maxTimeoutSeconds` | `120` |
| `extra.paymentFlow` | `"authorization"` |
| `extra.refundDeadline` | unix seconds; offer expiry plus protection window |
| `extra.offerId` | id of the signed offer (dynamic, single-use) |
| `extra.binding` | `"recourse-paypal/1"` |

`extensions["recourse-offer"].info.offer` carries the signed offer:

```json
{
  "body": {
    "v": 1,
    "offerId": "off_…",
    "publisherId": "pub_northwind",
    "resource": "https://publisher.example/northwind/germany-2027",
    "price": { "currency": "EUR", "minor": 490 },
    "contentSha256": "…64 hex…",
    "contentLength": 2210,
    "mimeType": "text/markdown",
    "title": "Germany 2027: e-invoicing for small businesses",
    "promise": "A practical report for German small businesses: …",
    "license": "read-and-cite",
    "protectionWindowSec": 600,
    "expiresAt": "2026-10-09T09:00:00.000Z"
  },
  "kid": "northwind-key-1",
  "sig": "<Ed25519 over RFC 8785 canonical JSON of body, base64url>"
}
```

## 3. `PaymentPayload`

```json
{
  "x402Version": 2,
  "accepted": { "…": "the chosen PaymentRequirements, copied" },
  "payload": {
    "type": "authorize",
    "authorization": {
      "v": 1,
      "agentId": "agt_…",
      "offerId": "off_…",
      "offerHash": "<sha256 of canonical offer body>",
      "network": "paypal:sandbox",
      "asset": "EUR",
      "amount": "490",
      "nonce": "<16–128 url-safe chars>",
      "validBefore": 1791547320
    },
    "kid": "agent-key-1",
    "signature": "<Ed25519 over canonical authorization, base64url>"
  },
  "extensions": { "recourse-offer": { "…": "echoed from PaymentRequired" } }
}
```

The agent's key is registered with the facilitator when the owner creates the agent. The
authorization binds the offer hash, so a publisher relaying it cannot reuse it for another price,
content or publisher. Bearer tokens never travel through the publisher.

Before settling, the resource server adds `payload.delivery` (x402 SDK: `enrichSettlementPayload`):

```json
{
  "body": { "v": 1, "offerId": "off_…", "deliveredSha256": "…", "deliveredLength": 2210, "deliveredAt": "…" },
  "kid": "northwind-key-1",
  "sig": "<publisher signature>"
}
```

## 4. Verification (`/verify`, read-only)

1. Scheme and network supported.
2. Offer present, signed by the registered key of `publisherId`.
3. `accepted` and the requirement match the signed offer (amount, asset, offer id).
4. Authorization matches requirement and offer hash; agent signature verifies with the agent's registered key.
5. Offer and authorization not expired.
6. Nonce unused; offer not yet paid.
7. Owner mandate allows it: currency, per-purchase limit, monthly budget, publisher allow-list.
8. Funding available: prepaid balance ≥ amount (below the funding threshold), or a vaulted PayPal wallet.

Invalid reasons: `unsupported_scheme`, `invalid_network`, `invalid_offer_signature`,
`invalid_payment_requirements`, `invalid_payload`, `invalid_agent_signature`, `offer_expired`,
`authorization_expired`, `replayed_nonce`, `offer_already_paid`, `mandate_violation`,
`insufficient_funds`.

## 5. Settlement (`/settle`)

In one database transaction: repeat all verification steps, consume the nonce, require a valid
delivery attestation, and require `deliveredSha256 == contentSha256`. On mismatch the facilitator
returns `success: false, errorReason: "delivery_mismatch"`, charges nothing and appends a
`settlement_refused` entry to the log. Otherwise:

- balance funding: debit the ledger;
- vault funding: `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` and
  `stored_credential.payment_initiator = MERCHANT` (completes without the payer present).

Then append a signed `receipt` entry to the log and return:

```json
{
  "success": true,
  "transaction": "pur_…",
  "network": "paypal:sandbox",
  "payer": "agt_…",
  "amount": "490",
  "extensions": {
    "recourse-receipt": {
      "info": {
        "purchaseId": "pur_…",
        "funding": "paypal_vault",
        "paypalCaptureId": "3B017991HX624902V",
        "receipt": { "seq": 12, "type": "receipt", "prevHash": "…", "at": "…", "data": { "…": "…" }, "hash": "…", "sig": "…", "kid": "recourse-1" },
        "claimUrl": "https://recourse.example/v1/claims",
        "verifyUrl": "https://recourse.example/v1/log/12"
      },
      "schema": { "type": "object" }
    }
  }
}
```

Publisher earnings stay pending until the protection window ends, then go out via PayPal Payouts.

## 6. Claims and refunds (out of band)

`POST /v1/claims` (agent bearer token) with reason codes `HASH_MISMATCH`, `NOT_AS_DESCRIBED`,
`PARTIALLY_AS_DESCRIBED`, `PROMPT_INJECTION`, the delivered bytes, and the agent's judge output.
The facilitator recomputes the hash, uses the stored delivery attestation, runs its own judge for
semantic reasons and decides with the same pure policy (`packages/policy`). Outcomes: `REFUND`,
`REJECT`, `CONTESTED`. Refunds: vault purchases via `POST /v2/payments/captures/{id}/refund`;
balance purchases as a partial refund of the top-up capture that funded the balance. Every
decision is a log entry.

## 7. Security considerations

- **Replay:** nonce consumed atomically at settle; offers single-use; authorizations expire.
- **Authorization scope:** the agent signs one offer hash; the mandate is enforced server side, so
  a compromised agent cannot exceed its owner's limits.
- **Settlement atomicity:** nonce, ledger debit and mandate check share one transaction; a failed
  PayPal charge frees the nonce.
- **Bait-and-switch:** prevented at settle when the gate is honest. When a modified gate signs the
  committed hash but sends other bytes, the agent's hash check catches it; the claim is `CONTESTED`
  (no money moves, the publisher must respond), because the evidence alone cannot tell a lying gate
  from a fabricating agent.
- **Fabricated evidence:** semantic claims are only judged on bytes that hash to the publisher's
  commitment; fabricated bytes are rejected.
- **Prompt injection against the judge:** the judged content is attacker-written; the injection
  score is the maximum of the model's estimate and deterministic hidden-text checks, and content
  is quarantined before it reaches the generative model.
