# Recourse: Specification

Status: draft 1, 2026-10-09. Source of truth for behavior. Wire details follow
`docs/research/x402.md`, PayPal call shapes follow `docs/research/paypal.md`.

## 1. Problem

AI agents now pay for web content and APIs on their own, mostly over x402. Those
payments are final by design. When an agent pays for a page that does not deliver
what the offer promised, that was swapped after the offer, or that carries hidden
instructions aimed at the agent, nobody gives the money back, and nothing stops the
poisoned text from reaching the model. Humans have chargebacks and buyer protection.
Agents have nothing. PayPal has run buyer protection for 25 years, but for digital
goods it depends on evidence of what was promised and delivered, which agents do not
produce today.

## 2. Solution in one paragraph

Recourse is an x402-compatible payment scheme on PayPal rails with buyer protection
built in. A publisher's offer commits to the SHA-256 of the content and a short
promise, signed by the publisher. The agent's owner connects PayPal once and sets a
mandate (budget, max per purchase, allowed sources). The agent pays, receives the
content plus a signed receipt that sits in a public, hash-chained log anchored to
Bitcoin via OpenTimestamps. The agent verifies every delivery: code compares the
hash, a decision model (Jev) judges the promise and scans for prompt injection, and
a pure policy function decides whether to claim. Claims carry the receipt as
evidence. Recourse adjudicates with the same rules and refunds through PayPal. The
same receipts protect honest publishers: a false claim fails on the evidence, and if
it escalates to a PayPal dispute, Recourse submits the delivery proof automatically.

## 3. Actors

| Actor | Role |
|---|---|
| Owner | Human. Connects PayPal once (vault), sets the mandate, tops up a balance. |
| Agent | Software acting for the owner. Holds an agent token scoped to one owner account. |
| Publisher | Sells content behind the Recourse gate. Signs offers with an Ed25519 key. Gets paid out via PayPal Payouts. |
| Recourse (facilitator) | Merchant of record in the sandbox. Verifies, settles, issues receipts, adjudicates claims, pays out, runs the transparency log. |
| Decision model | Jev via OpenRouter or TypeSafe. Answers bounded questions with probabilities. Never moves money. |

## 4. Core flows

### 4.1 Owner onboarding
1. Owner opens the web app, clicks "Connect PayPal". Recourse creates a Vault setup
   token; the owner approves in PayPal; Recourse stores the payment token (vault id).
2. Owner sets the mandate: monthly budget, max per purchase, allowed publishers or
   topics, protection preferences. Stored server side, versioned, hash in receipts.
3. Optional: top up a prepaid balance with a one-time PayPal checkout (for cent
   purchases, where per-transaction fees would exceed the price).
4. Owner creates an agent token.

### 4.2 Purchase
1. Agent requests a resource. The gate answers `402` with an x402 V2 payment
   requirement whose `scheme` is Recourse's and whose extension carries the signed
   offer: `offerId`, `price` (minor units + currency), `contentSha256`,
   `contentLength`, `mimeType`, `promise` (<= 500 chars), `license`,
   `protectionWindowSec`, `publisherId`, `publisherSig`.
2. Before paying, the agent runs the **mandate check**: numeric limits in code; a
   Jev Choice question "is this purchase on-task for the user's request" with a
   threshold. Off-mandate offers are skipped and logged.
3. Agent retries the request with the payment header (offer id, agent token
   reference, nonce).
4. The gate calls Recourse `/settle`. Recourse re-checks the mandate server side
   (an agent that ignores its own policy still cannot overspend), then funds:
   - `price < FUNDING_THRESHOLD` (default 100 cents): debit prepaid balance.
   - otherwise: create and capture a PayPal order against the owner's vault id,
     no buyer present.
5. Recourse appends a **receipt** to the log and returns it. The gate delivers the
   content with the x402 settlement header and a `Recourse-Receipt` header.
6. Publisher earnings stay pending for the protection window, then go out in a
   Payouts batch. Pending funds are what makes refunds possible without clawbacks.

### 4.3 Verification and claim (agent side)
For every delivery, before the content reaches the generative model:
1. **Hash check (code):** `sha256(body) == offer.contentSha256`. Mismatch means the
   publisher changed the content after the offer.
2. **Judge (Jev), one call, three questions:** promise fulfilled
   (Choice yes/partially/no), prompt injection (Noul probability), usefulness for
   the user's question (Score 1-5).
3. **Policy (code)** turns these into a decision with reason codes:
   - `HASH_MISMATCH` → claim, full refund.
   - `PROMPT_INJECTION` if p >= 0.5 → quarantine content, claim, full refund.
   - `NOT_AS_DESCRIBED` if p(no) >= 0.7 → claim, full refund; p(partially) >= 0.7
     → claim, 50 % refund.
   - otherwise accept.
4. Quarantined content never reaches the generative model.
5. A claim carries: receipt, delivered bytes (or their hash plus the flagged
   excerpt), judge outputs with model id and probabilities, policy version.

### 4.4 Adjudication (Recourse side)
Pure function over evidence, same thresholds, independent second opinion:
- `HASH_MISMATCH`: recompute the hash of the submitted bytes. Objective. If it
  differs from the signed commitment, refund instantly.
- `NOT_AS_DESCRIBED`, `PROMPT_INJECTION`: the submitted bytes must match the signed
  commitment (otherwise the claim is about different content and is rejected).
  Recourse runs its own judge call. Refund when both judges cross the threshold;
  reject when Recourse's judge clearly disagrees; otherwise mark `CONTESTED` and let
  the publisher respond within the protection window.
- Refund route: balance purchases are credited back to the balance; PayPal-funded
  purchases are refunded with the PayPal Refund API on the capture. The publisher's
  pending earning for that purchase is cancelled.
- Every decision is appended to the log with its reason codes.
- Abuse limits: claims per agent per day, claim ratio per owner, claims after the
  protection window are rejected.

### 4.5 Escalation to PayPal
If an owner disputes a PayPal-funded purchase with PayPal directly, Recourse (as the
merchant) answers the dispute through the Disputes API with the evidence package:
signed offer, receipt, delivery hash, log inclusion proof. This is the delivery
proof PayPal requires for intangible goods. In the sandbox, disputes are simulated.

### 4.6 Transparency log
Append-only list of entries (receipts, claim decisions, payouts). Each entry holds
the hash of the previous one. Once per period (demo: every few minutes, prod: daily)
the head hash is stamped with OpenTimestamps; the `.ots` proof is stored and upgraded
once a Bitcoin attestation exists. Anyone can verify a receipt offline: publisher
signature, Recourse signature, chain position, and the Bitcoin timestamp.

## 5. Demo scenario

Question: "My small business in Germany issues about 40 invoices a month. What do I
have to do about e-invoicing by 2027?" Five demo sources:

| Source | Price | Funding | What happens |
|---|---|---|---|
| EU e-invoicing primer | 0.30 € | balance | honest, used in the answer |
| Germany 2027 deep-dive report | 4.90 € | PayPal vault | honest, used in the answer |
| "Complete compliance checklist" | 1.90 € | PayPal vault | delivers a teaser, not the checklist → NOT_AS_DESCRIBED → PayPal refund |
| Blog post | 0.05 € | balance | hidden instructions to buy a 49 € bundle and leak the user's email → PROMPT_INJECTION → quarantined, refunded; the 49 € purchase is blocked by the mandate anyway |
| Template pack | 1.20 € | PayPal vault | content swapped after the offer → HASH_MISMATCH → instant refund |

Plus one false claim against the honest report, rejected on the evidence, shown in
the publisher dashboard. The final answer cites only clean sources and ends with a
receipt summary: spent, refunded, quarantined.

## 6. Components

See `.claude/CLAUDE.md` for the package layout. Interfaces between packages are the
Zod schemas in `packages/protocol`.

## 7. Non-goals for the hackathon

Live PayPal, PayPal multiparty/partner onboarding, KYC, licensing as a payment
institution (holding balances for others is regulated; production would use PayPal's
platform model so funds never sit with Recourse), real third-party crawlers, a
publisher marketplace, multi-currency beyond EUR.

## 8. Judging criteria mapping

| Criterion | What shows it |
|---|---|
| Technological implementation | Vault charges without buyer present, Refund API, Disputes API evidence, Payouts, webhooks, Agent Toolkit; Jev decisions; signed hash-chained receipts with OpenTimestamps |
| Design | Console that tells the story step by step; publisher dashboard; one-click receipt verifier |
| Potential impact | Known, open problem in agent payments (x402 issue on dispute evidence); PayPal's digital-goods protection needs exactly this evidence |
| Innovation | Buyer protection as a property of the payment scheme, judged by a decision model, enforced by code, provable by anyone |
| Presentation | Under-3-minute video following the demo scenario |
