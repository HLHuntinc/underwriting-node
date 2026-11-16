# @hlhunt/underwriting

The official TypeScript / Node.js SDK for the **HL Hunt Underwriting API**: underwrite applications, get live credit decisions from the Decision Agent, issue branded adverse-action letters, manage a funded portfolio, and receive signed webhooks.

- **Typed end to end**: every request and response is typed from the API's own OpenAPI document.
- **Safe to retry by default**: every create carries an idempotency key, reused on every retry, so a retry can never create twice.
- **Resilient**: automatic retries with exponential backoff and jitter. It honours `Retry-After`, and it never retries a request that would fail again.
- **Secure**: the key never appears in errors, logs or `JSON.stringify`. The SDK refuses to run in a browser, uses https only, and verifies webhooks in constant time with replay protection.
- **Zero dependencies**: built-in `fetch` and Web Crypto. Runs on Node 20+, and the webhook verifier also runs on Vercel/Next.js edge, Cloudflare Workers, Deno and Bun.
- **A CLI for local development**: `npx @hlhunt/underwriting listen` forwards your webhooks to localhost.

```bash
npm install @hlhunt/underwriting
```

## Quickstart

```ts
import { HLHunt } from "@hlhunt/underwriting"

const hlhunt = new HLHunt() // reads HLHUNT_API_KEY (hlh_test_... or hlh_live_...)

const decision = await hlhunt.decisions.createAndWait({
  decision_type: "new_credit",
  product: "business_card",
  applicant: { name: "Acme Logistics LLC", email: "ap@acme.example" },
  facts: { requested_amount: 25000, credit_score: 712, annual_revenue: 1200000, time_in_business_months: 40 },
  partner_verdict: "auto_approved",
})

console.log(decision.result?.outcome, decision.result?.amount, decision.result?.reasons)
// "approve" 25000 []   or   "counter" 15000 [{ code: "amount_exceeds_policy", text: "...", detail: "..." }]
```

Test keys (`hlh_test_...`) and live keys (`hlh_live_...`) see separate data. Test mode never contacts a real applicant.

## Configuration

```ts
const hlhunt = new HLHunt({
  apiKey: "hlh_live_...",          // default: process.env.HLHUNT_API_KEY
  baseURL: "https://...",          // default: process.env.HLHUNT_BASE_URL, then https://underwriting.hlhunt.org/api
  timeout: 60_000,                 // per attempt, ms
  maxRetries: 2,                   // after the first attempt
  appInfo: { name: "acme-platform", version: "4.2.0" }, // shows in our logs, helps support
})
```

Every method also takes per-call options: `{ idempotencyKey, timeout, maxRetries, signal, headers }`.

## The Decision Agent

Your platform sends credit requests and gets decisions made inside **your** credit policy. Policy knock-outs and caps are enforced in code, so the model can never overrule them. Adverse decisions carry Reg B reason codes, each with the applicant's figures. The agent advises; you make the final call and report it back.

```ts
// Decide (instant for policy knock-outs and test scenarios; ~10-60 s for agent decisions)
const d = await hlhunt.decisions.createAndWait({ decision_type: "limit_change", product: "business_card",
  applicant: { name: "Acme Logistics LLC" }, customer_id: "cus_123",
  facts: { current_limit: 20000, requested_amount: 40000, months_on_book: 14, utilization_pct: 81, delinquencies_12m: 0 } })

// Or fire and forget, and take the result from the `decision.completed` webhook
const queued = await hlhunt.decisions.create({ /* ... */ })

// Report what you did. An adverse outcome (decline, counter, reduce, close) issues the applicant's letter under your branding.
await hlhunt.decisions.reportOutcome(d.id, { outcome: "counter", amount: 30000 })

// Your credit policy, versioned
await hlhunt.decisionPolicies.update({
  product: "business_card",
  decision_type: "new_credit",
  rules: {
    knockouts: [{ id: "min_score", label: "Credit score below 600", fact: "credit_score", op: "lt", value: 600, reason: "delinquent_obligations" }],
    max_amount: 75000,
    refer_below_confidence: 60,
    instructions: "Steady deposits and positive cash flow matter more than score.",
  },
})
```

With a **test** key, pass `scenario: "approve" | "counter" | "decline" | "refer"` to get that outcome instantly (no model call, `simulated: true`) and wire every branch of your integration in minutes.

## Underwriting

```ts
const submission = await hlhunt.underwrite.create({ product_slug: "biz-credit-line", applicant: { /* ... */ }, consent: { /* ... */ } })

// Statements: PDFs, or photos of the pages (group the pages of one statement with statement_id)
import { readFile } from "node:fs/promises"
await hlhunt.cases.documents.upload(submission.id, {
  file: new Blob([await readFile("./july.pdf")], { type: "application/pdf" }),
  category: "financial",
})

const analysed = await hlhunt.cases.waitForAnalysis(submission.id)
await hlhunt.cases.decide(submission.id, { decision: "approve", reason: "Strong cash flow", approved_amount: 40000 })

const report = await hlhunt.cases.reportPdf(submission.id) // { data: Uint8Array, contentType, filename }
```

## Pagination

`await` a list call for the first page, or `for await` over it for every item on every page:

```ts
const page = await hlhunt.cases.list({ status: "approved", per_page: 50 })
page.data; page.pagination; page.hasNextPage()

for await (const c of hlhunt.cases.list({ status: "approved" })) {
  console.log(c.id)
}
```

## Errors

Every error extends `HLHuntError`. API errors carry `status`, `code`, `param`, `details` and `requestId`. Quote the request id to support.

```ts
import { ValidationError, RateLimitError, NotFoundError, HLHuntError } from "@hlhunt/underwriting"

try {
  await hlhunt.decisions.create(params)
} catch (err) {
  if (err instanceof ValidationError) console.log(err.param, err.message) // which field, and why
  else if (err instanceof NotFoundError) /* ... */;
  else if (err instanceof RateLimitError) console.log(err.retryAfterMs)
  else throw err
}
```

| Class | When | Retried automatically |
|---|---|---|
| `ValidationError` | 400 | no |
| `AuthenticationError` | 401 | no |
| `PermissionDeniedError` | 403 (missing scope) | no |
| `NotFoundError` | 404 | no |
| `ConflictError` | 409 | only an idempotent request still in progress |
| `IdempotencyKeyReusedError` | 409, key reused with a different body | no |
| `RateLimitError` | 429 | yes, after `Retry-After` |
| `InternalServerError` | 5xx | yes |
| `APIConnectionError` / `APITimeoutError` | network, timeout | yes |
| `WaitTimeoutError` | a `createAndWait` / `waitFor*` ran out of time (`.last` holds the latest state) | n/a |

## Idempotency

Every `create`, `update` and `report*` call sends an `Idempotency-Key`. It's generated once per call and reused on every retry, so a retry after a timeout returns the original result instead of creating a second one. To make an operation idempotent across processes (a job that may run twice), pass your own key:

```ts
await hlhunt.underwrite.create(params, { idempotencyKey: `application-${applicationId}` })
```

## Response metadata

```ts
const { data, response } = await hlhunt.decisions.retrieve(id).withResponse()
response.requestId    // for support
response.rateLimit    // { limit, remaining, resetAt }
response.attempts     // 1 = no retry
```

## Webhooks

Register an endpoint once (its signing secret is returned once: store it), then verify every delivery. Always pass the **raw** body.

```ts
const endpoint = await hlhunt.webhooks.create({ url: "https://acme.example/hlhunt/webhooks", events: ["decision.completed", "letter.issued"] })
// save endpoint.secret as HLHUNT_WEBHOOK_SECRET
```

**Next.js (App Router), Vercel / Cloudflare edge too:**

```ts
import { constructEvent, WebhookSignatureError } from "@hlhunt/underwriting/webhooks"

export async function POST(req: Request) {
  let event
  try {
    event = await constructEvent(await req.text(), req.headers.get("x-webhook-signature"), process.env.HLHUNT_WEBHOOK_SECRET!)
  } catch (err) {
    if (err instanceof WebhookSignatureError) return new Response("bad signature", { status: 400 })
    throw err
  }
  if (event.type === "decision.completed") {
    // event.data is a typed Decision
    await applyDecision(event.data.id, event.data.result)
  }
  return new Response(null, { status: 200 })
}
```

**Express:**

```ts
app.post("/hlhunt/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await hlhunt.webhooks.constructEvent(req.body, req.header("x-webhook-signature"), process.env.HLHUNT_WEBHOOK_SECRET!)
    // ...handle; de-duplicate on event.id (deliveries are at-least-once)
    res.sendStatus(200)
  } catch {
    res.sendStatus(400)
  }
})
```

Signatures older or newer than 5 minutes are refused (replay protection). During a secret rotation, pass both secrets: `constructEvent(body, header, [oldSecret, newSecret])`.

Missed something? Replay it: `await hlhunt.events.list({ type: "decision.completed", limit: 50 })`, or tail new events with `for await (const event of hlhunt.events.stream())`.

## Local development: `hlhunt listen`

No public URL needed. `listen` tails your events and POSTs each one to your local endpoint exactly as a webhook arrives, signed with a local secret it prints:

```bash
HLHUNT_API_KEY=hlh_test_... npx @hlhunt/underwriting listen --forward-to http://localhost:3000/hlhunt/webhooks
```

```
Ready. Forwarding test events to http://localhost:3000/hlhunt/webhooks
Verify forwarded events in your app with this signing secret:
  whsec_3f9c...
12:29:38  decision.completed           cmw3xwapn00ebzjs1tuhjadjq  -> 200 27 ms
```

Also: `npx @hlhunt/underwriting events` (recent events) and `events resend <id> --forward-to <url> --secret <whsec_>`.

## Resources

| | |
|---|---|
| `underwrite` | `create`, `createAndWait`, `createBatch`, `retrieveBatch`, `waitForBatch` |
| `cases` | `list`, `retrieve`, `decide`, `reanalyze`, `reportPdf`, `letters`, `waitForAnalysis`, `documents.list / upload / verify` |
| `decisions` | `create`, `createAndWait`, `retrieve`, `list`, `waitFor`, `reportOutcome` |
| `decisionPolicies` | `list`, `update` |
| `letters` | `pdf` |
| `branding` | `retrieve`, `update`, `uploadLogo` |
| `applicants` | `list`, `retrieve`, `update`, `sendLink` |
| `bankLinks` | `create`, `status`, `transactions` |
| `portfolio` | `summary`, `loans.list / retrieve / schedule / recordPayment` |
| `collections` | `list`, `logActivity`, `escalate` |
| `products` | `list` |
| `webhooks` | `create`, `list`, `del`, `constructEvent`, `verifySignature`, `generateTestHeader` |
| `events` | `list`, `stream` |

Full API reference: https://underwriting.hlhunt.org/docs

## Security

- Keep your API key on your server. The SDK throws if it detects a browser (`dangerouslyAllowBrowser: true` overrides this; don't).
- `baseURL` must be https (plain http only for `localhost`).
- The key is never included in errors, `JSON.stringify(client)` or `console.log(client)`.
- Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Requirements

Node.js 20 or later (or any runtime with `fetch`, `FormData` and Web Crypto). ESM and CommonJS are both supported.

## License

MIT

### Available information and incremental evidence

Submit the merchant information you already hold. `requested_amount` can be omitted or null;
unknown revenue or processing history does not block normal case creation. Use separate
`business_id` values for businesses sharing an owner and `auto_match_email: false`.

```ts
const submitted = await hlhunt.underwrite.create({
  product_slug: "biz-term-loan",
  applicant: { name: "Example Merchant LLC", email: "owner@example.com" },
  business_id: "merchant-001",
  website: "https://merchant.example",
  requested_amount: null,
  auto_match_email: false,
  facts: { processing_volume: 18000 },
})
await hlhunt.cases.addFacts(submitted.id, { facts: { fulfillment_delay_days: 3 } })
const current = await hlhunt.cases.retrieve(submitted.id)
console.log(current.available_assessment?.information_requests)
```

Use `cases.documents.upload` with category `financial` or `processing`. Normal case uploads
permit 25 MiB per file subject to hosting ingress limits; link an existing processed case to a decision with `case_id` to reuse its
extraction without hitting the Decision Agent's 4 MiB direct-upload limit. Decision methods
include `decisions.addFacts` and `decisions.documents.list/upload`. `waitFor` and
`createAndWait` also return on `awaiting_evidence`, allowing your UI to show specific requests.

Subscribe to normal `application.information_requested`, `.evidence_received`,
`.analysis_resumed`, `.analysis_completed`, `.analysis_failed`, and Decision
`decision.evidence_required`, `.evidence_received`, `.analysis_resumed`, `.completed`.
Verify signatures, durably deduplicate by event ID, and retrieve current state when notified.
Delivery can repeat or arrive out of order; do not overwrite current state with an older
payload. Advisory recommendations never authorize merchant boarding, limits, reserves or
applicant communications. Call final-action methods only after explicit authorization.

Website research returns quoted public-site findings and source links, not independent
business verification. Processing extraction keeps volume separate from revenue and credit.
See the [available-information guide](https://underwriting.hlhunt.org/docs/guides/available-information)
for field contracts, evidence limits, authorization requirements and update semantics.

### Bank links in your own email template

Funding and payment processors can request a link for an existing case without
an HL email. Call from your server and place `link.url` in your own email template:

```ts
const link = await hlhunt.bankLinks.create(
  { case_id: submitted.id, delivery: "link_only" },
  { idempotencyKey: `bank-link-${submitted.id}-1` },
)
// Save link.id, link.case_id and link.expires_at; pass link.url privately to your template.
const status = await hlhunt.bankLinks.status(link.id)
// Successful exchange automatically queues reanalysis; follow analysis completion events.
// Use cases.reanalyze(link.case_id) only for recovery or a new analysis.
```

`delivery` defaults to `email`; test keys always suppress email. `delivery_status`
is `sent`, `suppressed`, `failed`, `reused`, or `unknown` when the service supplies
no result. Sent means the provider call succeeded, not inbox receipt. Reused means
no new email; changing delivery does not force a resend. Expiry is seven days from
creation, and reuse does not extend it. Recipient overrides are not supported.

The portal URL is a **bearer secret**: keep it out of logs, analytics and public
pages. Never embed API keys in email templates, URLs or browser code. There is no
separate token. Omit submission-time `bank_link: true` / `bank_verification: "plaid"`
when planning this flow; those options retain default email behavior.

Retry the same request with the same Idempotency-Key; a changed body or mode returns
409. Verify and deduplicate `bank_link.connected` webhooks, correlate by `case_id`,
and retrieve current state. Successful exchange automatically and durably queues
reanalysis on the same case. `bank_link.connected` means data received, not analysis
completed. Follow application analysis events and retrieve the updated
available-information assessment. Manual `cases.reanalyze` is for recovery or a
new analysis. A connection does not authorize approval.

Link status `processing` means exchange is in progress: do not exchange again;
contact support if it stays stuck. `email_failed` means email delivery failed,
not that bank data was received. `review_failed` means bank data was stored but
the review handoff failed. Do not reconnect or retry exchange after data was
stored; recover with same-case reanalysis. Original PDF findings and the human
review hold remain for review.
