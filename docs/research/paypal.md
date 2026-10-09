# PayPal sandbox research for Recourse

Researched 2026-10-09 from primary sources only (developer.paypal.com `.md` pages and the official OpenAPI schemas under `developer.paypal.com/api/<api>/<version>/schema.json`, the `@paypal/agent-toolkit@1.11.0` npm package, github.com/paypal/*). `docs.paypal.ai` now 301-redirects to `developer.paypal.com/docsai/`; every developer.paypal.com page has a Markdown twin at `<url>.md`, and each API has a machine-readable schema at `/api/<name>/<ver>/schema.json`.

## TL;DR

| Question | Answer | Confidence |
|---|---|---|
| Can the agent be charged with no human present? | **Yes.** Vault v3 "save PayPal without purchase" (setup token, owner approves once, payment token), then `POST /v2/checkout/orders` with `payment_source.paypal.vault_id` (+ optional `stored_credential.payment_initiator=MERCHANT`). Docs: "Payers don't need to be present when charged." The order comes back `COMPLETED` in the create call, no capture call needed. | Docs + schema example. Not smoke-tested here. |
| Vault in sandbox by default? | Sandbox app: **Accept payments, then Advanced options, then Vault** must be checked. Docs also say live accounts need billing-agreement/reference-transaction approval. Sandbox approval status is not documented, so run the smoke test on day 1. | Medium |
| Germany/EU? | Germany is on the availability list for "Save PayPal with Payment Method Tokens API". EUR is a supported currency. | High |
| Disputes creatable via API in sandbox? | **Documented, but gated.** `POST /v1/customer/disputes` (sandbox-only, buyer simulation) needs the `disputes/create` scope, which per the docs **you have to request from a PayPal account manager**. It also needs a buyer consent flow plus a `PayPal-Auth-Assertion` JWT. The reliable path is the **sandbox Resolution Center UI as the personal buyer**. After that, everything is API-driven: list/get, provide-evidence, accept-claim, and the sandbox-only `require-evidence` and `adjudicate`. | High (docs explicit) |
| Payouts in sandbox? | Works with a default "Merchant" sandbox app; the default sandbox token scope includes `https://uri.paypal.com/payments/payouts`. Live needs approval. | Medium-high |
| Webhooks to localhost? | No. PayPal delivers only to a public HTTPS URL on port 443. Use a tunnel (cloudflared or ngrok) or deploy. | High |
| Agent Toolkit | `@paypal/agent-toolkit` **1.11.0** (2026-09-01). It has `create_order`, `pay_order`, `create_refund`, `get_refund`, `list_disputes`, `get_dispute`, `accept_dispute_claim`, `list_transactions`, `get_merchant_insights` and more. **`create_order` is USD-only and has no vault support.** Remote MCP sandbox: `https://mcp.sandbox.paypal.com/sse` or `/http`. | High (read from package source) |

---

## 0. Common basics

- Sandbox REST base: `https://api-m.sandbox.paypal.com`. Buyer approval pages run on `https://www.sandbox.paypal.com`.
- Headers on every POST: `Authorization: Bearer <token>`, `Content-Type: application/json`, `PayPal-Request-Id: <uuid>` (idempotency key).
  - Retention: Vault setup tokens keep it for 3 h, Payouts for 30 days, refunds for "up to 45 days".
  - A key must be unique per request and per call type. Two simultaneous requests with the same key: the second may fail.
  - Without the header, a retry **duplicates** the action.
- Optional `Prefer: return=representation` returns the full resource; the default is minimal.
- `PayPal-Mock-Response: {"mock_application_codes":"<ERROR_CODE>"}` triggers negative tests on Orders v2 and Payments v2 (sandbox only).

---

## 1. OAuth2 client credentials

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/oauth2/token \
  -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials"
```

```json
{
  "scope": "https://uri.paypal.com/services/invoicing https://uri.paypal.com/services/disputes/read-buyer ... https://uri.paypal.com/services/disputes/update-seller https://uri.paypal.com/services/payments/refund https://uri.paypal.com/payments/payouts https://uri.paypal.com/services/vault/payment-tokens/readwrite ...",
  "access_token": "A21AA...",
  "token_type": "Bearer",
  "app_id": "APP-80W284485P519543T",
  "expires_in": 32400,
  "nonce": "2026-...Z..."
}
```

- Cache the token until `expires_in` (about 8–9 h). Do not fetch one per request; PayPal names "token misuse" as a rate-limit trigger.
- **Use the `scope` string as a feature probe.** It tells you whether vault (`vault/payment-tokens/readwrite`), payouts (`payments/payouts`), and dispute creation (`disputes/create`, normally absent) are enabled for the app.
- Browser client token (JS SDK v6, needed only for Fastlane according to the setup page, but used by the official vault sample): same call plus `-d 'response_type=client_token' -d 'domains[]=https://your.app'`.

---

## 2. Vault v3: save PayPal without purchase, then charge with no human present

Availability (Payment Method Tokens API, PayPal wallet) covers US, CA, CN, HK, JP, SG, AU, and in Europe AT, BE, BG, CY, CZ, DK, EE, FI, FR, **DE**, HU, IE, IT, LV, LI, LT, LU, MT, NL, NO, PL, PT, RO, SK, SI, ES, SE and GB.

### 2a. Create setup token (server)

```bash
curl -X POST https://api-m.sandbox.paypal.com/v3/vault/setup-tokens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: $(uuidgen)" \
  -d '{
    "customer": { "merchant_customer_id": "owner_42" },
    "payment_source": {
      "paypal": {
        "description": "Recourse: your AI agent may buy digital content on your behalf (max 20 EUR/day)",
        "usage_pattern": "UNSCHEDULED_PREPAID",
        "usage_type": "MERCHANT",
        "customer_type": "CONSUMER",
        "permit_multiple_payment_tokens": false,
        "experience_context": {
          "brand_name": "Recourse",
          "locale": "de-DE",
          "shipping_preference": "NO_SHIPPING",
          "return_url": "https://recourse.example/vault/return",
          "cancel_url": "https://recourse.example/vault/cancel"
        }
      }
    }
  }'
```

`usage_pattern` enum: IMMEDIATE, DEFERRED, RECURRING_PREPAID/POSTPAID, THRESHOLD_PREPAID/POSTPAID, SUBSCRIPTION_PREPAID/POSTPAID, UNSCHEDULED_PREPAID/POSTPAID, INSTALLMENT_PREPAID/POSTPAID. I recommend **`UNSCHEDULED_PREPAID`**. PayPal defines it as "Unscheduled card on file plan where the merchant can bill buyer upfront based on an agreed logic, but amount due and frequency can vary. Inclusive of automatic reload plans". That covers per-purchase charges and auto top-ups. Note that the v3 schema's description of `UNSCHEDULED_POSTPAID` is a copy-paste of the installment text, which is a schema bug. Other optional fields: `experience_context.user_action` (`SETUP_NOW` | `CONTINUE`), and `vault_instruction` (deprecated, but the official sample still sends `ON_PAYER_APPROVAL`).

Response (`201`, or `200` on an idempotent replay):

```json
{
  "id": "4G4976650J0948357",
  "customer": { "id": "customer_4029352051" },
  "status": "PAYER_ACTION_REQUIRED",
  "payment_source": { "paypal": { "usage_pattern": "...", "usage_type": "MERCHANT", "customer_type": "CONSUMER" } },
  "links": [
    { "rel": "self",    "method": "GET", "href": "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/4G4976650J0948357" },
    { "rel": "approve", "method": "GET", "href": "https://sandbox.paypal.com/agreements/approve?approval_session_id=4G4976650J0948357" }
  ]
}
```

Send the owner to `links[rel=approve]` and have them log in with a **sandbox personal account**. The setup token expires after 3 days. Check its state with `GET /v3/vault/setup-tokens/{id}`; expect `APPROVED` after the owner approves.

### 2b. Exchange the approved setup token for a payment token (server)

```bash
curl -X POST https://api-m.sandbox.paypal.com/v3/vault/payment-tokens \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: $(uuidgen)" \
  -d '{ "payment_source": { "token": { "id": "4G4976650J0948357", "type": "SETUP_TOKEN" } } }'
```

```json
{
  "id": "jwgvx42",
  "customer": { "id": "customer_4029352051" },
  "payment_source": { "paypal": {
      "usage_pattern": "IMMEDIATE", "usage_type": "MERCHANT", "customer_type": "CONSUMER",
      "email_address": "email@example.com", "payer_id": "AJM9JTWQJCFTA" } },
  "links": [
    { "rel": "self",   "method": "GET",    "href": ".../v3/vault/payment-tokens/jwgvx42" },
    { "rel": "delete", "method": "DELETE", "href": ".../v3/vault/payment-tokens/jwgvx42" }
  ]
}
```

Store `id` (this is the `vault_id`) and `customer.id` **server-side only**. Never send them to the browser. Other calls: `GET /v3/vault/payment-tokens?customer_id=...` lists tokens, and `DELETE /v3/vault/payment-tokens/{id}` revokes one; the "revoke mandate" button can use this. Webhooks: `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`, `VAULT.PAYMENT-TOKEN.DELETION-INITIATED`. The owner can also cancel the agreement on paypal.com, which is another reason to subscribe to these.

Browser variant (JS SDK v6; official sample `paypal-examples/v6-web-sdk-sample-integration`):

```js
const sdk = await window.paypal.createInstance({ clientToken, components: ["paypal-payments"], pageType: "checkout" });
const methods = await sdk.findEligibleMethods({ currencyCode: "EUR", paymentFlow: "VAULT_WITHOUT_PAYMENT" });
if (methods.isEligible("paypal")) {
  const session = sdk.createPayPalSavePaymentSession({
    async onApprove(data) { await fetch("/api/vault/payment-token", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ vaultSetupToken: data.vaultSetupToken }) }); },
    onCancel() {}, onError(e) { console.error(e); },
  });
  button.addEventListener("click", () => {
    const p = createSetupTokenOnServer();               // do NOT await before start() (transient activation)
    session.start({ presentationMode: "auto" }, p);      // p resolves to { setupToken: "<id>" }
  });
}
```

### 2c. Charge the vaulted wallet with nobody present (merchant-initiated)

```bash
curl -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: purchase_<recourse_purchase_id>" \
  -H "Prefer: return=representation" \
  -d '{
    "intent": "CAPTURE",
    "purchase_units": [{
      "reference_id": "purchase_8f3a",
      "custom_id": "sha256:<64-hex commitment>",
      "invoice_id": "RCS-2026-000123",
      "description": "Chapter 3: 'Agent payments' by publisher X",
      "amount": { "currency_code": "EUR", "value": "1.50",
                  "breakdown": { "item_total": { "currency_code": "EUR", "value": "1.50" } } },
      "items": [{ "name": "Chapter 3", "quantity": "1", "category": "DIGITAL_GOODS",
                  "unit_amount": { "currency_code": "EUR", "value": "1.50" },
                  "url": "https://publisher.example/reports/123", "sku": "pub-x/report-123" }]
    }],
    "payment_source": {
      "paypal": {
        "vault_id": "jwgvx42",
        "stored_credential": {
          "payment_initiator": "MERCHANT",
          "usage": "SUBSEQUENT",
          "usage_pattern": "UNSCHEDULED_PREPAID"
        }
      }
    }
  }'
```

The response comes back `COMPLETED` in one step (a sample from the official guide, shortened):

```json
{
  "id": "4TH21426N05692944",
  "status": "COMPLETED",
  "payment_source": { "paypal": { "email_address": "...", "account_id": "AJM9JTWQJCFTA" } },
  "purchase_units": [{
    "reference_id": "default",
    "payments": { "captures": [{
      "id": "3B017991HX624902V",
      "status": "COMPLETED",
      "amount": { "currency_code": "USD", "value": "100.00" },
      "final_capture": true,
      "seller_protection": { "status": "ELIGIBLE", "dispute_categories": ["ITEM_NOT_RECEIVED","UNAUTHORIZED_TRANSACTION"] },
      "seller_receivable_breakdown": { "gross_amount": {...}, "paypal_fee": {...}, "net_amount": {...} },
      "links": [ { "rel": "self", "href": ".../v2/payments/captures/3B017991HX624902V" },
                 { "rel": "refund", "method": "POST", "href": ".../v2/payments/captures/3B017991HX624902V/refund" },
                 { "rel": "up", "href": ".../v2/checkout/orders/4TH21426N05692944" } ]
    }]}
  }]
}
```

- Store `purchase_units[0].payments.captures[0].id`; it is the refund handle.
- `stored_credential` is optional in the guide samples but present in the official schema example `authorize_single_step_paypal_with_vault_id_and_stored_credentials_usage_pattern`. The schema requires `payment_initiator` (CUSTOMER | MERCHANT); `usage` takes FIRST | SUBSEQUENT | DERIVED (default DERIVED).
- If the response is not `COMPLETED` (for example `APPROVED`/`CREATED`), call `POST /v2/checkout/orders/{id}/capture`. A capture can also be `PENDING` with `status_details.reason`, for example `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` (see Gotchas).
- **PSD2 risk:** the schema has a documented `422 UNPROCESSABLE_ENTITY / PAYER_ACTION_REQUIRED` ("PSD2 SCA compliance requirement") plus a `payer-action` link. Treat it as "mandate needs owner re-approval": stop the agent and notify the owner. Simulate it with `PayPal-Mock-Response: {"mock_application_codes":"PAYER_ACTION_REQUIRED"}`.
- RDA warning from the docs: customer-initiated vault payments without FraudNet/Magnes risk data "are likely to be declined". Recourse charges are merchant-initiated, so this mainly concerns live mode. `PayPal-Client-Metadata-Id` is the header for it.
- Alternative "save with purchase" (first top-up also vaults): `payment_source.paypal.attributes.vault = {store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER"}` plus `experience_context.return_url/cancel_url`. The vault id is then returned in the capture response at `payment_source.paypal.attributes.vault.id` with `status: "CREATED"`.

---

## 3. One-time checkout for top-ups (Orders v2 + JS SDK v6)

Create (server):

```bash
curl -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: topup_<id>" \
  -d '{
    "intent": "CAPTURE",
    "purchase_units": [{ "reference_id": "topup_<id>", "custom_id": "owner_42",
                         "amount": { "currency_code": "EUR", "value": "10.00" } }],
    "payment_source": { "paypal": { "experience_context": {
        "brand_name": "Recourse", "locale": "de-DE", "shipping_preference": "NO_SHIPPING",
        "user_action": "PAY_NOW",
        "return_url": "https://recourse.example/topup/return",
        "cancel_url": "https://recourse.example/topup/cancel" } } }
  }'
```

Minimal response without `payment_source` (official "simple" example). With `payment_source.paypal` the link is `rel: "payer-action"` instead of `approve`:

```json
{ "id": "5O190127TN364715T", "status": "CREATED",
  "links": [ { "rel": "self", "href": ".../v2/checkout/orders/5O190127TN364715T" },
             { "rel": "approve", "href": "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T" },
             { "rel": "capture", "method": "POST", "href": ".../v2/checkout/orders/5O190127TN364715T/capture" } ] }
```

Capture (server, after approval):

```bash
curl -X POST https://api-m.sandbox.paypal.com/v2/checkout/orders/5O190127TN364715T/capture \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "PayPal-Request-Id: cap_topup_<id>"
```

The response is `201` with `status: "COMPLETED"` and `purchase_units[0].payments.captures[0].{id,status,amount,seller_receivable_breakdown}`. A replay with the same `PayPal-Request-Id` returns `200`.

JS SDK v6 button (official Node/Express guide):

```html
<script src="https://www.sandbox.paypal.com/web-sdk/v6/core"></script>   <!-- live: https://www.paypal.com/web-sdk/v6/core -->
<paypal-button id="paypal-button" hidden></paypal-button>
<script>
  window.addEventListener("load", async () => {
    const sdk = await window.paypal.createInstance({ clientId: "<SANDBOX_CLIENT_ID>", components: ["paypal-payments"], pageType: "checkout" });
    const btn = document.getElementById("paypal-button");
    btn.addEventListener("click", async () => {
      const session = sdk.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => { await fetch(`/api/topups/${orderId}/capture`, { method: "POST" }); },
        onCancel() {}, onError(e) { console.error(e); },
      });
      await session.start({ presentationMode: "auto" },            // auto | popup | modal | redirect | payment-handler
        fetch("/api/topups", { method: "POST" }).then(r => r.json())); // must resolve to { orderId }
    });
    btn.removeAttribute("hidden");
  });
</script>
```

The server SDK is `@paypal/paypal-server-sdk` (2.5.0, `OrdersController`, `VaultController`, `OAuthAuthorizationController`). Plain `fetch` works just as well.

---

## 4. Refunds

```bash
# full refund: empty body
curl -X POST https://api-m.sandbox.paypal.com/v2/payments/captures/3B017991HX624902V/refund \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: refund_<claim_id>" -H "Prefer: return=representation" -d '{}'

# partial refund
  -d '{ "amount": { "value": "0.40", "currency_code": "EUR" },
        "invoice_id": "RCS-CLAIM-77", "custom_id": "claim_77",
        "note_to_payer": "Recourse claim 77: delivered content did not match commitment" }'
```

```json
{
  "id": "1JU08902781691411",
  "amount": { "value": "10.99", "currency_code": "USD" },
  "status": "COMPLETED",
  "seller_payable_breakdown": {
    "gross_amount": {...}, "paypal_fee": {...}, "net_amount": {...},
    "total_refunded_amount": { "value": "10.99", "currency_code": "USD" }
  },
  "invoice_id": "INVOICE-123",
  "links": [ { "rel": "self", "href": ".../v2/payments/refunds/1JU08902781691411" },
             { "rel": "up",   "href": ".../v2/payments/captures/2GG279541U471931P" } ]
}
```

- Status values: `COMPLETED | PENDING | FAILED | CANCELLED`. **The sandbox completes refunds instantly.**
- `GET /v2/payments/refunds/{id}` shows refund details. Webhooks: `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED`.
- Multiple partial refunds per capture work "until limit" (`MAX_NUMBER_OF_REFUNDS_EXCEEDED`; the count is not published).
- Same currency as the capture. Refunds are allowed up to 180 days after capture.
- `TRANSACTION_DISPUTED`: no partial refund while a PayPal case is open.
- `REFUND_NOT_PERMITTED_DUE_TO_CHARGEBACK` and `REFUND_AMOUNT_EXCEEDED` also exist.
- **Design hint for cent purchases from the prepaid balance:** issue a *partial refund of the top-up capture* that funded them. The owner then sees a real PayPal refund instead of an internal credit. Mind the per-capture refund-count cap: batch claims.

---

## 5. Disputes

### 5a. Creating a dispute in sandbox (buyer simulation)

**Path A (reliable, UI).** Log in at `https://www.sandbox.paypal.com` as the sandbox **personal** account (the owner/payer), open the transaction under Activity, then "Report a problem" (Resolution Center), and open an INR/SNAD case. Webhooks fire. Disputed-action links appear "after a few minutes".

**Path B (API, sandbox-only, gated):** `POST /v1/customer/disputes`. It is **not** in the public OpenAPI schema.

Prerequisites from `/disputes/set-up`:
1. "Contact your PayPal account manager" to add the scopes `https://uri.paypal.com/services/disputes/create` (and `disputes/update-buyer` for change-reason) to the REST app.
2. Get buyer consent through a "Log in with PayPal" button (sandbox, with that scope), logged in as the personal account.
3. Send a `PayPal-Auth-Assertion` header with an unsigned JWT: base64url `{"alg":"none","typ":"JWT"}` . base64url `{"iss":"<CLIENT_ID>","email":"<buyer sandbox email>"}` . (empty signature).

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/customer/disputes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: multipart/form-data" \
  -H "PayPal-Auth-Assertion: <jwt>" \
  -F 'input={
    "disputed_transactions": [{ "buyer_transaction_id": "<BUYER-SIDE TXN ID>" }],
    "reason": "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    "dispute_amount": { "currency_code": "EUR", "value": "1.50" },
    "extensions": { "merchant_contacted": true, "merchant_contacted_outcome": "NO_RESPONSE",
                    "merchandize_dispute_properties": { "issue_type": "PRODUCT" } }
  };type=application/json'
```

```json
{ "links": [ { "href": "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803", "rel": "self", "method": "GET" } ] }
```

- Returns `201`. Use the buyer-side transaction id, not the seller-side one.
- Adding `"evidences":[{"notes":"ACCELERATED_RESPONSE_ENABLED"}]` simulates Accelerated Response. Transaction amounts 5.00–5.99, 9.00–9.99 and >=11.00 USD simulate escalation on day 5, 9 and 11.
- Sibling sandbox-only buyer endpoints, also with `PayPal-Auth-Assertion`: `POST /v1/customer/disputes/{id}/change-reason` (multipart), `/accept-offer`, `/deny-offer`.

**Path C (chargeback simulation, card-funded only):** `POST /v2/customer-support/process-chargeback`, sandbox-only, JSON. The docs list no extra scope, but the transaction must be card-funded.

```json
{ "adjacency": "PAYPAL", "file_layout": "ATCK_CB", "merchant_id": "<merchant id>",
  "financial_institution": { "processor": "FDMS" },
  "transaction": { "id_enc": "<SELLER-TRANSACTION-ID>", "amount": { "currency_code": "USD", "value": "20" } },
  "instrument": { "instrument_type": "CARD", "card_brand": "VISA", "credit_card_transaction_id": "2347289342893472", "external": false },
  "dispute": { "id": null, "stage": "CHARGEBACK", "status": "2", "amount": { "currency_code": "USD", "value": "10" },
               "receive_date": "<now ISO>", "money_movement_date": "<now ISO>", "response_date": "<future ISO>",
               "event_code": "CHARGEBACK_INITIATED", "event_type": "DEBIT", "chargeback_type": "REPORTED_TO_PROCESSOR",
               "processor_info": { "reference_number": "31639435342702423793399", "reason_code": "1330", "notes": "TEST_MEMO" } } }
```

Response `201`: `{ "dispute_id": "PP-D-1234" }`. Card reason codes for the test scenarios: Visa `C2`, Mastercard `4853`.

### 5b. Merchant side (works with the default sandbox scopes `disputes/read-seller` and `disputes/update-seller`)

```bash
GET  /v1/customer/disputes?disputed_transaction_id=...&dispute_state=REQUIRED_ACTION&page_size=50
GET  /v1/customer/disputes/{id}
```

Key fields in `GET /{id}`:
- `status`: OPEN | WAITING_FOR_SELLER_RESPONSE | WAITING_FOR_BUYER_RESPONSE | UNDER_REVIEW | RESOLVED
- `dispute_life_cycle_stage`: INQUIRY | CHARGEBACK | PRE_ARBITRATION | ARBITRATION
- `reason`, `dispute_amount`, `seller_response_due_date`
- `evidences[]` with `source: REQUESTED_FROM_SELLER` and the requested `evidence_type`
- `allowed_response_options.accept_claim.accept_claim_types` (REFUND, PARTIAL_REFUND, REFUND_WITH_RETURN, ...) and `make_offer.offer_types`
- `links[]` (HATEOAS: the only reliable signal of which actions are allowed now)
- `disputed_transactions[].{buyer_transaction_id, seller_transaction_id}`

Provide evidence (multipart, JSON part named `input`, files as extra parts; jpg/jpeg/gif/png/pdf, under 10 MB each, at most 50 MB per call):

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803/provide-evidence \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: multipart/form-data" \
  -F 'input={ "evidences": [ {
        "evidence_type": "OTHER",
        "notes": "Signed receipt + SHA-256 commitment attached. Delivered bytes hash = <x>, committed hash = <y>."
     } ] };type=application/json' \
  -F 'file1=@receipt.pdf;type=application/pdf'
# -> 200 { "links": [ { "rel": "self", "href": ".../v1/customer/disputes/PP-D-27803" } ] }
```

Evidence by reason: `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` takes `OTHER` (notes/documents) or `PROOF_OF_REFUND` (`evidence_info.refund_ids`). `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` takes `PROOF_OF_FULFILLMENT` (`evidence_info.tracking_info[]` or notes/docs) or `PROOF_OF_REFUND`. For the sandbox internal-dispute scenarios PayPal says "use `OTHER` as the evidence type". `notes` holds at most 2000 chars.

Accept claim. This refunds the buyer from the merchant balance. The schema's content type is `multipart/form-data` (optional file part `accept-claim-document`); the guide sample sends JSON:

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-27803/accept-claim \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "note": "Full refund to the customer.", "accept_claim_type": "REFUND" }'
# PARTIAL_REFUND: add "refund_amount": {"currency_code":"EUR","value":"0.50"}
```

Other merchant actions:
- `send-message`: JSON or multipart `input` + `file1`
- `make-offer`: `offer_type` REFUND / REFUND_WITH_RETURN / ...; `offer_amount`
- `escalate`: `{ "note": ... }`, moves INQUIRY to CHARGEBACK
- `provide-supporting-info`, `appeal`, `acknowledge-return-item`

### 5c. Sandbox-only "PayPal agent" endpoints (merchant token, no special scope)

```bash
# precondition: status == UNDER_REVIEW and the link is present in GET /{id}
POST /v1/customer/disputes/{id}/require-evidence   {"action": "SELLER_EVIDENCE"}   # or BUYER_EVIDENCE -> WAITING_FOR_*_RESPONSE
POST /v1/customer/disputes/{id}/adjudicate         {"adjudication_outcome": "BUYER_FAVOR"}  # or SELLER_FAVOR -> RESOLVED, CUSTOMER.DISPUTE.RESOLVED
# both -> 200 { "links": [ { "rel": "self", ... } ] }
```

Test values: `GET /v1/customer/disputes/ERRDIS015` simulates FORBIDDEN; `ERRDIS016`–`ERRDIS021` simulate other errors; on list, `?disputed_transaction_id=ERRDIS023..034`. Appeal testing: a buyer email containing `allowappeal` or `noappeal`.

Webhooks: `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED` (`RISK.DISPUTE.CREATED` is deprecated).

---

## 6. Payouts (publisher payouts)

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/payments/payouts \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "PayPal-Request-Id: payout_2026-10-09_pubx" \
  -d '{
    "sender_batch_header": {
      "sender_batch_id": "recourse_2026-10-09_pubx",
      "email_subject": "Recourse payout",
      "email_message": "Your earnings for verified deliveries"
    },
    "items": [{
      "recipient_type": "EMAIL",
      "receiver": "sb-publisher@business.example.com",
      "amount": { "value": "3.40", "currency": "EUR" },
      "note": "12 verified deliveries, 0 refunded",
      "sender_item_id": "pubx_2026-10-09"
    }]
  }'
```

```json
{ "batch_header": { "payout_batch_id": "3TRXJ4Z8XJ8QY", "batch_status": "PENDING",
                    "sender_batch_header": { "sender_batch_id": "recourse_2026-10-09_pubx", "email_subject": "Recourse payout" } },
  "links": [ { "rel": "self", "method": "GET", "href": "https://api-m.sandbox.paypal.com/v1/payments/payouts/3TRXJ4Z8XJ8QY" } ] }
```

- Note: Payouts uses `amount.currency`, not `currency_code` as in Orders.
- `recipient_type`: EMAIL | PHONE | PAYPAL_ID | USER_HANDLE (Venmo, US only).
- **`sender_batch_id` must be unique for 30 days.** A reuse is rejected with a link to the original batch, so retry a 5xx with the same id.
- Poll with `GET /v1/payments/payouts/{payout_batch_id}`, which returns `batch_header.batch_status` (`PENDING|PROCESSING|SUCCESS|DENIED|CANCELED`) and `items[].transaction_status`.
- Item status: `GET /v1/payments/payouts-item/{payout_item_id}`. Statuses: `SUCCESS|FAILED|PENDING|UNCLAIMED|RETURNED|ONHOLD|BLOCKED|REFUNDED|REVERSED`.
- Cancel an unclaimed item with `POST /v1/payments/payouts-item/{id}/cancel`; unclaimed items return after 30 days.
- Rate limit: 400 POST/min.
- Errors to expect: `INSUFFICIENT_FUNDS` (payouts come from the facilitator's balance), `NON_HOLDING_CURRENCY` (no balance in that currency), `SELF_PAY_NOT_ALLOWED`, `RECEIVER_UNREGISTERED`/`UNCLAIMED` (receiver email is not a sandbox account), `REQUIRED_SCOPE_MISSING`.
- Simulation: `items[0].note = "ERRPYO002"` returns SENDER_EMAIL_UNCONFIRMED; `GET /v1/payments/payouts/ERRPYO015` returns CLOSED_MARKET.
- Webhooks: `PAYMENT.PAYOUTSBATCH.{PROCESSING,SUCCESS,DENIED}`, `PAYMENT.PAYOUTS-ITEM.{SUCCEEDED,FAILED,UNCLAIMED,RETURNED,HELD,BLOCKED,REFUNDED,CANCELED}`. Batch events carry no item data, so follow the HATEOAS links.
- Live mode needs "request access" (paypal.com/payoutsweb/landing); the docs say "in the meantime, you can set up and test your integration in your sandbox accounts".

---

## 7. Webhooks

Events relevant to Recourse:

| Purpose | Events |
|---|---|
| Top-up/charge | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REVERSED` |
| Refund | `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.REFUND.PENDING`, `PAYMENT.REFUND.FAILED` |
| Disputes | `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED` |
| Payouts | `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*` |
| Mandate | `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`, `VAULT.PAYMENT-TOKEN.DELETION-INITIATED` |

Register in the dashboard (App, then Sandbox Webhooks, then Add Webhook; at most 10 URLs per app, `*` = all) or via the API:

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/notifications/webhooks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "url": "https://<tunnel>.trycloudflare.com/paypal/webhook",
        "event_types": [ {"name":"PAYMENT.CAPTURE.COMPLETED"}, {"name":"PAYMENT.CAPTURE.REFUNDED"},
                         {"name":"CUSTOMER.DISPUTE.CREATED"}, {"name":"CUSTOMER.DISPUTE.UPDATED"},
                         {"name":"CUSTOMER.DISPUTE.RESOLVED"}, {"name":"PAYMENT.PAYOUTS-ITEM.SUCCEEDED"} ] }'
# -> { "id": "<WEBHOOK_ID>", ... }   keep this id; it is needed for verification
```

Verify by postback:

```bash
curl -X POST https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "auth_algo": "<PAYPAL-AUTH-ALGO header>", "cert_url": "<PAYPAL-CERT-URL>",
        "transmission_id": "<PAYPAL-TRANSMISSION-ID>", "transmission_sig": "<PAYPAL-TRANSMISSION-SIG>",
        "transmission_time": "<PAYPAL-TRANSMISSION-TIME>", "webhook_id": "<WEBHOOK_ID>",
        "webhook_event": <raw event body, byte-identical> }'
# -> { "verification_status": "SUCCESS" }   (or "FAILURE")
```

Self-verification (preferred by PayPal):
1. Build the message `"<transmission_id>|<transmission_time>|<webhook_id>|<crc32(raw body) as decimal>"`.
2. Download and cache the PEM from `paypal-cert-url`.
3. Run `crypto.createVerify('SHA256').update(msg).verify(pem, Buffer.from(sig,'base64'))`.

Always use the **raw** body; re-serialized JSON fails verification.

- Delivery goes only to **public HTTPS on port 443**; localhost is unreachable, so use a tunnel. A non-2xx response causes up to 25 retries over 3 days. Answer 200 fast and process asynchronously.
- Simulator: dashboard `developer.paypal.com/dashboard/webhooksSimulator`, or the API `POST /v1/notifications/simulate-event {"url":"https://...","event_type":"PAYMENT.CAPTURE.COMPLETED","resource_version":"2.0"}` (or `webhook_id` instead of `url`).
- Mock events are not tied to an app and **cannot be verified by postback**. For self-verification, use the literal string `WEBHOOK_ID` as the webhook id.
- Real sandbox events are visible and resendable from the dashboard events page or `POST /v1/notifications/webhooks-events/{id}/resend`.

---

## 8. PayPal Agent Toolkit and MCP

- npm `@paypal/agent-toolkit` **1.11.0** (published 2026-09-01; repo `github.com/paypal/agent-toolkit`, last push 2026-09-01). Python: `pip install paypal-agent-toolkit`.
- Exports: `@paypal/agent-toolkit/ai-sdk`, `/openai`, `/langchain`, `/bedrock`, `/mcp`.
- Node 18+. Depends on `ai@^4`, `zod@^3`, `openai@4.86.1`, `@modelcontextprotocol/sdk@^1.6`, `@paypal/paypal-server-sdk@^1`.
- `github.com/paypal/AI-Toolkit` is a different thing: a **coding-agent plugin** (Claude Code `/plugin install paypal@claude-plugins-official`) with best-practice skills and the sandbox MCP. It is useful while building, not at runtime.

Full TS tool list (method, then `configuration.actions` key), read from the package source:

| Area | Tools |
|---|---|
| Orders/payments | `create_order` (orders.create), `get_order` (orders.get), `pay_order` (orders.capture), `create_refund` (payments.createRefund), `get_refund` (payments.getRefunds) |
| Disputes | `list_disputes` (disputes.list), `get_dispute` (disputes.get), `accept_dispute_claim` (**disputes.create**) |
| Reporting | `list_transactions` (transactions.list), `get_merchant_insights` (insights.get) |
| Invoices | create, list, get, send, sendReminder, cancel, delete, generateQRC, generateInvoiceNumber, search, update, setupReminders, updateReminder, cancelReminders, recordPayment, recordRefund, createConditionalRules, createRecurringSeries, activateRecurringSeries, getRecurringSeries, cancelRecurringSeries, deleteRecurringSeries |
| Catalog/subscriptions/shipping | products.{create,list,update,show}, subscriptionPlans.{create,list,show}, plan.update, subscriptions.{create,show,cancel,update}, shipment.{create,get,update} |
| Remote MCP only | `search_product`, `create_cart`, `checkout_cart` (gift-card commerce; header `x-feature-flags: commerce:true`) |

There is **no** vault, payouts, provide-evidence, or webhook tool.

Tool parameter shapes that matter:
- `create_refund`: `{capture_id, amount?: {currency_code, value}, invoice_id?, note_to_payer?}`.
- `list_disputes`: `{disputed_transaction_id?, dispute_state?: REQUIRED_ACTION|REQUIRED_OTHER_PARTY_ACTION|UNDER_PAYPAL_REVIEW|RESOLVED|OPEN_INQUIRIES|APPEALABLE, page_size<=50, page}`.
- `accept_dispute_claim`: `{dispute_id, note}`.
- `list_transactions`: `{transaction_id?, transaction_status: D|P|S|V, start_date, end_date (<=31 days), search_months, page_size<=500}`.
- `create_order`: `{currencyCode: "USD" only, items[], discount?, shippingCost?, shippingAddress?, notes?, returnUrl?, cancelUrl?}`.

Vercel AI SDK usage (docs):

```ts
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import { generateText } from "ai";
const paypal = new PayPalAgentToolkit({
  clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
  configuration: {
    // read-only tools for the model; money-moving tools stay out of the LLM's tool list
    actions: { orders: { get: true }, payments: { getRefunds: true },
               disputes: { list: true, get: true }, transactions: { list: true } },
    context: { sandbox: true },
  },
});
const { text } = await generateText({ model, tools: { ...paypal.getTools() }, maxSteps: 10,
  prompt: "Summarise the PayPal state of order 4TH21426N05692944 and any open dispute on it." });
```

Plain function calling (provider-agnostic, recommended if the app uses Claude or AI SDK v5+):

```ts
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/openai";
const tk = new PayPalAgentToolkit({ clientId, clientSecret, configuration: { actions: {...}, context: { sandbox: true } } });
const tools = tk.getTools();                 // ChatCompletionTool[] (JSON Schema in tools[i].function.parameters)
// Claude: map to { name: t.function.name, description: t.function.description, input_schema: t.function.parameters }
const result = await tk.handleToolCall({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
// MCP-style direct call: new PayPalMCPToolkit({accessToken, configuration}).getPaypalAPIService().run("create_refund", args)
```

MCP servers:
- Local: `npx -y @paypal/mcp --tools=all` (npm `@paypal/mcp` 1.8.1, env `PAYPAL_ACCESS_TOKEN`, `PAYPAL_ENVIRONMENT=SANDBOX`).
- Remote sandbox: `https://mcp.sandbox.paypal.com/sse` (SSE) or `https://mcp.sandbox.paypal.com/http` (streamable HTTP). Auth is either OAuth login via `npx mcp-remote <url>` or `Authorization: Bearer <sandbox access token>` (the AI-Toolkit `.mcp.json` uses `{"type":"sse","url":"https://mcp.sandbox.paypal.com/sse","headers":{"Authorization":"Bearer ${PAYPAL_SANDBOX_ACCESS_TOKEN}"}}`).
- Live: `https://mcp.paypal.com/sse` and `/http`.

**Fit with "the model judges, code decides":** give the model only the read-only toolkit tools (`get_order`, `get_refund`, `list_disputes`, `get_dispute`, `list_transactions`) for evidence gathering and explanations. Money-moving toolkit tools (`create_refund`, `accept_dispute_claim`) are executed **by code** after `packages/policy` approves: `tk.handleToolCall(...)` from the `/openai` export, or `PayPalMCPToolkit#getPaypalAPIService().run("create_refund", args)`. Never expose them in the LLM tool list. That keeps toolkit usage visible without letting an LLM move money. Charging the vaulted wallet and payouts must stay plain REST, because the toolkit cannot do vault, EUR orders or payouts.

---

## 9. Rate limits, currency, sandbox quirks

- PayPal publishes **no** general rate limits. Payouts allows 400 POST/min. A breach returns `429 RATE_LIMIT_REACHED`; honour `Retry-After` and back off. Triggers include polling instead of webhooks and fetching a token per call.
- EUR is supported (2 decimals; HUF, JPY and TWD have 0). "To receive payments in a currency that you do not hold … the payment status remains pending until you manually approve" (capture `PENDING`, reason `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`). **Create the merchant sandbox business account with country Germany** so EUR is its primary currency, or set Payment Receiving Preferences on the sandbox business account.
- Minimum amount: no documented minimum beyond the currency's decimal precision (0.01). PayPal fees appear in `seller_receivable_breakdown.paypal_fee`. Fixed-fee pricing makes sub-1-EUR real charges uneconomic; this supports the prepaid-balance design for cents.
- Transaction Search (`/v1/reporting/transactions`, which backs the toolkit's `list_transactions`): "It takes a maximum of three hours for executed transactions to appear". Do not rely on it in a live demo; use `GET /v2/checkout/orders/{id}` or `GET /v2/payments/captures/{id}` instead.
- Negative testing: set the sandbox business account's Settings to Negative Testing **On**, then use `PayPal-Mock-Response`. It works for Orders v2 and Payments v2 (create, capture, refund, ...).

---

## Gotchas

1. **The toolkit's `create_order` is hard-coded to `currencyCode: z.enum(["USD"])` and cannot take `payment_source.vault_id`.** Do EUR or vault charges via REST.
2. **Toolkit `accept_dispute_claim` is enabled by `disputes: { create: true }`**, not `accept`. Its `note` is validated against `^[A-Za-z0-9_-]{1,255}$`, so **no spaces** ("Full_refund_claim_77" works, "Full refund" fails validation).
3. Toolkit `ai-sdk` export is built on **AI SDK v4** (`ai@^4`, `tool({parameters})`, `maxSteps`). Current `ai` is 7.x. With v5+ use the `/openai` export (JSON Schema plus `handleToolCall`) or the MCP server instead of `getTools()`.
4. Toolkit caches the OAuth token forever (`_accessToken ||= ...`, no expiry check). In a long-running server, re-create the toolkit every few hours or on 401. Do not set `context.request_id`: it becomes a **static** `PayPal-Request-Id` on every call, so the second refund would replay the first.
5. Toolkit `create_refund` posts its whole args object (including `capture_id`) as the body. The effect on PayPal's validation is untested.
6. Vault-charge create order normally returns `COMPLETED` directly. Do not blindly call `/capture` afterwards; branch on `status`.
7. EU: handle `422 PAYER_ACTION_REQUIRED` (PSD2 SCA) on vault charges as "mandate needs re-approval".
8. Merchant account currency: a US sandbox merchant receiving EUR leaves captures `PENDING`. Use a DE business account. Payouts in EUR need an EUR balance (`NON_HOLDING_CURRENCY`, `INSUFFICIENT_FUNDS`): create the business account as a custom account with an EUR balance, or fund it with top-ups first.
9. A dispute only exists for a real PayPal transaction. Cent purchases paid from the internal balance have no PayPal transaction, so a PayPal dispute can only target a top-up or a >=1 EUR vault charge. Partial refunds are blocked while a case is open (`TRANSACTION_DISPUTED`).
10. Dispute actions appear only "a few minutes" after creation. Always drive actions from HATEOAS `links`, not from assumptions.
11. Evidence and dispute creation are **multipart** with a part named `input` (`;type=application/json`). Files must be jpg/gif/png/pdf, under 10 MB each, at most 50 MB per call. Hash proofs belong in `notes` (at most 2000 chars) or a PDF.
12. Webhook verification fails when the body is re-serialized. Keep the raw body (`express.raw`). Simulator events cannot be postback-verified.
13. Payouts `sender_batch_id` is unique for 30 days, so do not reuse demo batch ids. Payouts uses `currency`; Orders and Refunds use `currency_code`.
14. Setup tokens expire after 3 days. The approve link host is `sandbox.paypal.com/agreements/approve?...`; the owner must log in with a **sandbox personal** account, never a real one.
15. Docs disagree on SDK auth for vault: `/sdk/js/set-up` says `clientId` for everything except Fastlane, while the vault guide and official sample use `clientToken`. The save session callback field is `data.vaultSetupToken` (official sample); the reference page says `billingToken`. Handle both.
16. `invoice_id` must be unique per merchant (`DUPLICATE_INVOICE_ID`). `custom_id` (max 255) is not shown to the payer but appears in reports, so it is a good place for the SHA-256 commitment. `description` is truncated at 127 chars, `soft_descriptor` at 22.
17. Transaction Search lag of up to 3 h makes `list_transactions` useless for live demo verification.

---

## What must be clicked in the developer dashboard (human checklist)

1. developer.paypal.com: log in, then **Sandbox**, then **Accounts**, then **Create Account**:
   - **Business, country Germany** (merchant of record "Recourse facilitator"; via *Create Custom Account* give it an EUR PayPal balance, for example 500 EUR, so payouts work before any top-up).
   - **Personal, country Germany** (the "owner" who approves the vault agreement and tops up; fund it via a custom balance or a test card).
   - **Business or Personal, Germany** for each demo **publisher** (payout receivers).
   - Optional: a personal buyer with `allowappeal` in the email, for appeal tests.
   - Note each account's email and password (*View/Edit Account*).
2. **Apps & Credentials, Sandbox, Create App**: type **Merchant**, linked to the DE business account. Copy the Client ID and Secret into `.env`.
3. In the app's **Features**:
   - **Accept payments** checked; under **Advanced options**, **Vault** checked (needed for setup and payment tokens).
   - **Payouts** checked, if shown.
   - **Customer disputes** checked (default).
   - **Transaction search** checked, if shown (for the toolkit's `list_transactions`).
   - **Log in with PayPal** only if you want to try the gated dispute-create API.
4. **Sandbox Webhooks, Add Webhook**: tunnel URL (https, port 443), select the events from section 7, and copy the **Webhook ID** into `.env`.
5. Sandbox business account, then *View/Edit*, then **Settings**: switch **Negative Testing** On (only when testing error paths; it affects all transactions of that merchant).
6. Log in at `https://www.sandbox.paypal.com` as the DE business account and check **Account Settings, Payments, Payment receiving preferences**: accept other currencies automatically (in case a non-EUR payment arrives).
7. Verify the token scope after setup (section 1): it must contain `vault/payment-tokens/readwrite` and `payments/payouts`.
8. Optional: to get the API dispute-create scope (`disputes/create`), a PayPal account manager or developer support is needed. Do not plan on it before 12 Nov; demo disputes through the sandbox Resolution Center UI (personal account, Activity, Report a problem).

---

## Uncertain (not confirmed in primary docs; smoke-test on day 1)

- Whether **DE sandbox** business accounts can create PayPal vault setup tokens without extra enablement. The docs require billing-agreement/reference-transaction approval for live and say nothing explicit about sandbox. Fallback: US sandbox accounts in USD.
- Whether `stored_credential.payment_initiator = MERCHANT` changes anything in sandbox (risk or SCA). It is optional in the guides and present in the schema example.
- Whether the sandbox ever returns the PSD2 `PAYER_ACTION_REQUIRED` on vault charges for DE payers, or only under mock.
- Exact query parameters on the vault `return_url` after approval (not documented). Rely on the stored setup token id and `GET /v3/vault/setup-tokens/{id}`.
- Whether `POST /v1/customer/disputes` actually enforces the `disputes/create` scope in sandbox (the docs say request it), and whether `process-chargeback` needs special scopes (the docs list none).
- Whether the **Payouts** checkbox must be ticked in sandbox apps today. The default sandbox token scope samples include `payments/payouts`; the AI-Toolkit skill says "Access requires approval via the PayPal Developer Dashboard".
- Remote MCP `/sse` with a plain `Authorization: Bearer <client-credentials token>`: shown in PayPal's own AI-Toolkit config, while the quickstart describes OAuth login via `mcp-remote`. Behaviour with Claude or other runtime MCP clients is untested.
- Maximum number of partial refunds per capture (`MAX_NUMBER_OF_REFUNDS_EXCEEDED`; not published).
- PayPal fee amounts in sandbox for EUR micro-amounts (they appear in responses; the live DE pricing was not verified here).
- Accept-claim body field names beyond `note` (`accept_claim_type`, `refund_amount`): taken from the test-guide prose and `allowed_response_options`, not from a full JSON sample.

---

## Sources

- Authentication: https://developer.paypal.com/api/rest/authentication.md
- Request headers, PayPal-Auth-Assertion, PayPal-Request-Id: https://developer.paypal.com/api/rest/requests.md
- Idempotency: https://developer.paypal.com/api/rest/reference/idempotency.md
- Save PayPal without purchase (Vault v3): https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal.md
- JS SDK v6 save PayPal: https://developer.paypal.com/sdk/save-without-purchase/paypal.md
- Save PayPal for future payments (charge without payer present): https://developer.paypal.com/checkout/save-customer-info.md
- Save payment methods overview: https://developer.paypal.com/v5/save-payment-methods/overview.md
- Orders v2 save-with-purchase: https://developer.paypal.com/api/orders-v2/save-with-purchase/paypal.md
- Orders API use case (vault): https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/save-payment-methods.md
- Reference-transaction error: https://developer.paypal.com/api/rest/troubleshooting/rest_merchant_not_enabled_for_reference_transaction.md
- OpenAPI schemas: https://developer.paypal.com/api/payment-tokens/v3/schema.json, https://developer.paypal.com/api/orders/v2/schema.json, https://developer.paypal.com/api/payments/v2/schema.json, https://developer.paypal.com/api/customer-disputes/v1/schema.json, https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json, https://developer.paypal.com/api/webhooks/v1/schema.json, https://developer.paypal.com/api/transaction-search/v1/schema.json
- Node/Express checkout with JS SDK v6: https://developer.paypal.com/guides/node-express.md
- JS SDK v6 setup and reference: https://developer.paypal.com/sdk/js/set-up.md, https://developer.paypal.com/sdk/js/reference.md
- Official v6 sample: https://github.com/paypal-examples/v6-web-sdk-sample-integration
- Refunds: https://developer.paypal.com/checkout/refund-payment.md
- Disputes: https://developer.paypal.com/disputes/test-go-live.md, https://developer.paypal.com/disputes/set-up.md, https://developer.paypal.com/api/disputes.md, https://developer.paypal.com/api/disputes/test-values.md, https://developer.paypal.com/disputes/reasons-evidence.md, https://developer.paypal.com/disputes/supported-file-sizes-types.md, https://developer.paypal.com/disputes/disputes-lifecycle.md
- Payouts: https://developer.paypal.com/api/payouts.md, https://developer.paypal.com/api/payouts/customize.md, https://developer.paypal.com/api/payouts/test-go-live.md, https://developer.paypal.com/payouts/use-payouts/set-up.md, https://developer.paypal.com/payouts/use-payouts/overview.md, https://developer.paypal.com/payouts/use-payouts/track-payout-item-status.md, https://developer.paypal.com/payouts/webhooks.md, https://developer.paypal.com/payouts/faqs.md
- Webhooks: https://developer.paypal.com/api/rest/webhooks.md, https://developer.paypal.com/api/rest/webhooks/rest.md, https://developer.paypal.com/api/rest/webhooks/simulator.md, https://developer.paypal.com/api/rest/webhooks/event-names.md
- Agent toolkit: https://developer.paypal.com/ai-tools/toolkit.md, https://developer.paypal.com/ai-tools/agent-tools.md, https://developer.paypal.com/ai-tools/mcp-server.md, https://github.com/paypal/agent-toolkit, https://www.npmjs.com/package/@paypal/agent-toolkit (1.11.0 tarball inspected), https://github.com/paypal/AI-Toolkit (README, `.mcp.json`, skills/paypal-best-practices/references/*)
- Rate limits: https://developer.paypal.com/api/rate-limiting.md, https://developer.paypal.com/api/rest/reference/rate-limiting.md
- Currency and receiving preferences: https://developer.paypal.com/reference/currency-codes.md, https://developer.paypal.com/api/errors/currency-not-allowed.md
- Negative testing: https://developer.paypal.com/negative-testing/overview.md, https://developer.paypal.com/negative-testing/request-headers.md
- Sandbox accounts: https://developer.paypal.com/sandbox-testing/accounts.md, https://developer.paypal.com/sandbox-testing/overview.md
- Scopes: https://developer.paypal.com/apps-scopes-and-credentials.md
- Docs index: https://developer.paypal.com/llms.txt
