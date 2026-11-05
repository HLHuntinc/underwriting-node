# Decision Agent: runnable example

The [integration guide](https://underwriting.hlhunt.org/docs/guides/decision-agent) as code. It uses a **test** key, so nothing here contacts a real applicant.

```bash
npm install
export HLHUNT_API_KEY=<your test key>          # dashboard → API → create key (test mode)
```

Three terminals:

```bash
# 1. Tail your events and forward them to the local receiver. Copy the secret it prints.
npx hlhunt listen --forward-to http://localhost:4242/webhooks

# 2. The receiver: verifies every delivery and logs the decisions.
WEBHOOK_SIGNING_KEY=<the secret from 1> node webhook-server.mjs

# 3. Run the guide.
node integrate.mjs
```

What `integrate.mjs` does:

1. Sets a credit policy for `business_card` / `new_credit` (knock-outs, caps, refer threshold, instructions).
2. Runs every outcome instantly with test scenarios (`approve`, `counter`, `decline`, `refer`), plus a policy knock-out.
3. Sends a real request and waits for the agent's decision.
4. Reports a final decline, which issues the applicant's letter, and saves the PDF to `letters/`.
5. Shows a typed validation error, then replays the latest `decision.completed` events.

Terminal 2 shows each `decision.completed` and `letter.issued` webhook, verified. The dashboard's **Decision Agent** page shows the same decisions live.

Pass `--branding` to `integrate.mjs` to also set the brand name on your letters (it changes your organization's letters).
