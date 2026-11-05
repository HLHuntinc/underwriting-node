#!/usr/bin/env node
/**
 * A minimal webhook receiver: verifies every delivery, ignores duplicates,
 * and acts on the Decision Agent's results. No framework needed.
 *
 *   WEBHOOK_SIGNING_KEY=<the whsec_ secret> node webhook-server.mjs
 *
 * In development, run `npx hlhunt listen --forward-to http://localhost:4242/webhooks`
 * and use the secret it prints. In production, use the secret returned once
 * by `hlhunt.webhooks.create(...)`.
 */
import { createServer } from "node:http"
import { constructEvent, WebhookSignatureError } from "@hlhunt/underwriting/webhooks"

const signingKey = process.env.WEBHOOK_SIGNING_KEY
if (!signingKey) {
  console.error("Set WEBHOOK_SIGNING_KEY to your endpoint's whsec_ secret.")
  process.exit(1)
}
const PORT = Number(process.env.PORT ?? 4242)
const seen = new Set() // use a database table in production: deliveries are at-least-once

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks") return res.writeHead(404).end()
  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", async () => {
    const raw = Buffer.concat(chunks) // the RAW body: never re-serialise before verifying
    let event
    try {
      event = await constructEvent(raw, req.headers["x-webhook-signature"], signingKey)
    } catch (err) {
      console.warn(`rejected: ${err instanceof WebhookSignatureError ? err.message : err}`)
      return res.writeHead(400).end()
    }
    if (seen.has(event.id)) return res.writeHead(200).end() // already handled
    seen.add(event.id)

    switch (event.type) {
      case "decision.completed": {
        const d = event.data
        if (d.status === "failed") console.log(`decision ${d.id} failed: decide it yourself or resubmit`)
        else console.log(`decision ${d.id} (${d.external_id ?? "-"}): ${d.result?.outcome} ${d.result?.amount ?? ""}${d.result?.reasons.length ? " because " + d.result.reasons.map((r) => r.code).join(", ") : ""}`)
        // -> apply to your own system, then report your final call:
        //    await hlhunt.decisions.reportOutcome(d.id, { outcome: "approve", amount: d.result.amount })
        break
      }
      case "letter.issued":
        console.log(`letter ${event.data.id} ${event.data.status} (${event.data.kind})`)
        break
      default:
        console.log(`${event.type} ${event.id}`)
    }
    res.writeHead(200).end()
  })
}).listen(PORT, () => console.log(`Listening on http://localhost:${PORT}/webhooks`))
