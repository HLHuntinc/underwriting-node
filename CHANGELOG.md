# Changelog

## 0.2.1 (2026-11-16)

- Bank links support `delivery: "link_only"` for partner-owned email templates and explicit delivery status.
- Explicit `resend` option for replacement links, with documented first-included/admin-priced repeat billing.
- Updated bank verification lifecycle documentation, automatic same-case reanalysis, and recovery guidance.

## 0.2.0 (2026-11-16)

- Available-information case facts/authorization updates, Decision facts and document methods.
- Optional/null amounts and business-scoped evidence contracts regenerated from OpenAPI.
- Website/processing evidence response types and lifecycle webhook events.
- Behavior change: `decisions.waitFor` and `createAndWait` return at `awaiting_evidence` for incremental completion. Callers must handle this state rather than assuming every return is a terminal decision.

This project follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version may include breaking changes; they are called out here.

## 0.1.0

First release.

- `HLHunt` client with typed resources: `underwrite`, `cases` (+ `documents`), `decisions`, `decisionPolicies`, `letters`, `branding`, `applicants`, `bankLinks`, `portfolio` (+ `loans`), `collections`, `products`, `webhooks`, `events`.
- Automatic idempotency keys on every POST/PATCH, reused across retries.
- Retries with exponential backoff and jitter on connection errors, timeouts, 408, 429 (honouring `Retry-After`), 5xx, and in-progress idempotent requests.
- Typed errors with `code`, `param`, `details` and `requestId`.
- `for await` pagination across pages; `.withResponse()` for request id and rate limits.
- `createAndWait`, `waitFor`, `waitForAnalysis`, `waitForBatch` helpers.
- Webhook verification (`constructEvent`, `verifySignature`) on Web Crypto, constant-time, with replay protection and secret rotation; available standalone from `@hlhunt/underwriting/webhooks`.
- `hlhunt` CLI: `listen --forward-to`, `events`, `events resend`.
