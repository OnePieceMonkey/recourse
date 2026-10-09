# Recourse

Buyer protection for AI agents, on PayPal rails. Entry for the PayPal AI Hackathon
(Devpost, submission deadline **2026-11-12, 12:00 PT / 21:00 CET**). The repo becomes
public at submission, so everything committed here is public: English only, no
personal data, no secrets, no strategy notes.

## The idea in three sentences

x402-style agent payments are final: an agent that pays for garbage or for a page
with hidden instructions has no recourse. Recourse adds it: every offer commits to a
SHA-256 of the content and a plain-language promise, every purchase yields a signed,
hash-chained receipt, and the agent verifies each delivery. On a mismatch it files a
claim with the receipt as evidence and gets its money back through PayPal.

## Hard rules

- **The model judges, code decides.** Jev (or any decision model) answers bounded
  questions with probabilities. Whether money moves is decided by pure functions in
  `packages/policy` with explicit thresholds. Never let an LLM call a payment API
  on its own judgment.
- **Hash checks are code, never AI.** Commitment vs. delivered bytes is a SHA-256
  comparison.
- **PayPal sandbox only.** `PAYPAL_ENV` must be `sandbox`; the client refuses `live`.
- **No secrets in git.** `.env` is ignored; `.env.example` holds empty values.
- **Private planning** lives in `.planning/private/` (excluded via
  `.git/info/exclude`, not `.gitignore`). Never commit it.
- Amounts are integer minor units (cents) everywhere. No floats for money.

## Stack

TypeScript (strict, ESM), pnpm workspaces, Node >= 22. Hono for HTTP services,
Next.js for the web app, Zod for schemas, Vitest for tests. PGlite locally,
Postgres (`DATABASE_URL`) when hosted, same SQL for both.

Shared packages use `moduleResolution: "Bundler"` and extensionless imports, so
Next.js and `tsx` consume their TypeScript sources directly (avoids the Next 16
NodeNext `.js` resolution trap).

## Layout

```
packages/protocol   x402 V2 wire types + Recourse extension (offer commitment, receipt, claim)
packages/receipts   Ed25519 signing, canonical JSON, hash chain, OpenTimestamps anchoring
packages/policy     pure decision functions: mandate check, claim decision
packages/judge      decision-model adapters: Jev (OpenRouter/TypeSafe) + offline heuristic
packages/paypal     thin PayPal REST client + in-memory fake for tests
packages/gate       Hono middleware for publishers: 402 offers, settle, deliver + receipt
apps/facilitator    Recourse server: accounts, vault, ledger, settle, claims, payouts, log
apps/publisher-demo demo publishers (honest, not-as-described, poisoned)
apps/agent          research agent (Gemini plans/answers, Jev judges, policy decides)
apps/web            console, publisher dashboard (AG Grid), receipt verifier, owner setup
```

## Conventions

- Code comments in English, short, explain the why.
- Tests next to code (`*.test.ts`). Every policy rule has a test.
- `readJson = (r: Response) => r.json() as Promise<any>` in tests (Response.json is
  `unknown` in @types/node 26).
- Commit messages: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).

## Specs

`docs/SPEC.md` is the source of truth for behavior. Research notes with exact API
shapes live in `docs/research/`.
