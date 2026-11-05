# Changelog

This project follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version may include breaking changes; they are called out here.

## 0.1.0 (unreleased)

First release.

- `HLHunt` client with typed resources: `underwrite`, `cases` (+ `documents`), `decisions`, `decisionPolicies`, `letters`, `branding`, `applicants`, `bankLinks`, `portfolio` (+ `loans`), `collections`, `products`, `webhooks`, `events`.
- Automatic idempotency keys on every POST/PATCH, reused across retries.
- Retries with exponential backoff and jitter on connection errors, timeouts, 408, 429 (honouring `Retry-After`), 5xx, and in-progress idempotent requests.
- Typed errors with `code`, `param`, `details` and `requestId`.
- `for await` pagination across pages; `.withResponse()` for request id and rate limits.
- `createAndWait`, `waitFor`, `waitForAnalysis`, `waitForBatch` helpers.
- Webhook verification (`constructEvent`, `verifySignature`) on Web Crypto, constant-time, with replay protection and secret rotation; available standalone from `@hlhunt/underwriting/webhooks`.
- `hlhunt` CLI: `listen --forward-to`, `events`, `events resend`.
