# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub's **"Report a vulnerability"** (Security tab of this repository). Do not open a public issue.

Include what you found, how to reproduce it, and its impact. We acknowledge reports within two business days and keep you informed until the fix ships.

## Supported versions

The latest minor release receives security fixes.

## How the SDK protects you

- The API key is held in a private field and never appears in errors, `JSON.stringify(client)` or `util.inspect(client)`.
- The client refuses to run in a browser by default, so a secret key cannot be shipped to visitors.
- Requests go over https only (plain http is accepted for `localhost` development).
- Webhook signatures are verified with HMAC-SHA256 in constant time, with a 5-minute replay window and support for rotating secrets.
- No runtime dependencies: nothing outside this package executes in your process.
- Releases are published from CI with npm provenance, so you can verify a tarball was built from this repository.
