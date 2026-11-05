#!/usr/bin/env node
/**
 * The Decision Agent integration guide, as one runnable script.
 * https://underwriting.hlhunt.org/docs/guides/decision-agent
 *
 *   HLHUNT_API_KEY=<your TEST key> node integrate.mjs
 *
 * Run `node webhook-server.mjs` and `npx hlhunt listen --forward-to http://localhost:4242/webhooks`
 * beside it to watch the webhooks arrive. Uses only test-mode features: nothing
 * here contacts a real applicant.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { HLHunt, ValidationError, HLHuntError } from "@hlhunt/underwriting"

const hlhunt = new HLHunt({ appInfo: { name: "decision-agent-example", version: "1.0.0" } })
if (hlhunt.mode !== "test") {
  console.error("Use a TEST key for this example (hlh_test_...).")
  process.exit(1)
}
const step = (n, title) => console.log(`\n\u001b[1m${n}. ${title}\u001b[0m`)
// Policies belong to your whole organization (test and live). Point this at a
// scratch product key to try the example without touching a real policy.
const PRODUCT = process.env.EXAMPLE_PRODUCT ?? "business_card"

// 3. Branding (only if you pass --branding: it changes your organization's letters)
if (process.argv.includes("--branding")) {
  step(3, "Branding")
  const b = await hlhunt.branding.update({ brand_name: "Example Business Card", support_email: "support@example.com", letter_delivery: "email" })
  console.log(`   letters go out as "${b.brand_name}"`)
}

// 4. Policy
step(4, "Credit policy")
const policy = await hlhunt.decisionPolicies.update({
  product: PRODUCT,
  decision_type: "new_credit",
  rules: {
    knockouts: [
      { id: "min_score", label: "Owner credit score below 600", fact: "credit_score", op: "lt", value: 600, reason: "delinquent_obligations" },
      { id: "min_tib", label: "In business under 6 months", fact: "time_in_business_months", op: "lt", value: 6, reason: "insufficient_time_in_business" },
      { id: "kyb", label: "KYB not passed", fact: "kyb_passed", op: "false", reason: "unable_to_verify_identity" },
    ],
    required_facts: ["requested_amount"],
    max_amount: 75000,
    max_amount_pct_of_monthly_revenue: 60,
    refer_below_confidence: 60,
    instructions: "Charge card paid in full monthly. Steady deposits and positive cash flow matter more than score.",
  },
})
console.log(`   ${policy.product} / ${policy.decision_type} is now version ${policy.version}`)

// 5. Every branch, instantly, with test scenarios
step(5, "Test scenarios")
for (const scenario of ["approve", "counter", "decline", "refer"]) {
  const d = await hlhunt.decisions.create({
    decision_type: "new_credit", product: PRODUCT, scenario,
    applicant: { name: `Scenario ${scenario} LLC`, email: "test@example.com" },
    facts: { requested_amount: 10000 },
  })
  console.log(`   ${scenario.padEnd(8)} -> ${d.status} ${d.result?.outcome} ${d.result?.amount ?? ""} (simulated: ${d.simulated})`)
}

// A knock-out: decided by your policy in the response, no model call
const ko = await hlhunt.decisions.create({
  decision_type: "new_credit", product: PRODUCT, applicant: { name: "Low Score LLC" },
  facts: { requested_amount: 15000, FICO: "571", tib_months: 40 },
})
console.log(`   knock-out -> ${ko.result?.outcome} by ${ko.result?.decided_by}: ${ko.result?.reasons.map((r) => r.text).join("; ")}`)

// 7. A real agent decision (about 10-60 s)
step(7, "A real decision")
const started = Date.now()
const decision = await hlhunt.decisions.createAndWait(
  {
    decision_type: "new_credit",
    product: PRODUCT,
    external_id: `example-${Date.now()}`,
    customer_id: "example-customer-1",
    partner_verdict: "auto_approved",
    applicant: { name: "Acme Logistics LLC", email: "ap@acme.example", type: "business", address: { line1: "100 Main St", city: "Austin", state: "TX", zip: "78701" } },
    facts: { requested_amount: 25000, credit_score: 712, annual_revenue: "$1,200,000", time_in_business_months: 40, avg_monthly_deposits: 98000, monthly_net_cash_flow: 9200, nsf_count_90d: 0, kyb_passed: true },
  },
  { timeout: 180_000 },
)
const r = decision.result
console.log(`   ${r?.outcome} ${r?.amount ?? ""} (confidence ${r?.confidence}, ${((Date.now() - started) / 1000).toFixed(1)} s, agrees with your system: ${r?.agrees_with_partner})`)
console.log(`   ${r?.summary}`)

// 8. Your final call. An adverse one issues the letter (watermarked in test mode, never emailed).
step(8, "Final outcome and letter")
const final = await hlhunt.decisions.reportOutcome(ko.id, { outcome: "decline", note: "Policy knock-out" })
const pdf = await hlhunt.letters.pdf(final.letter_id)
await mkdir("letters", { recursive: true })
await writeFile(`letters/${pdf.filename ?? final.letter_id + ".pdf"}`, pdf.data)
console.log(`   letter ${final.letter_id} saved to letters/ (${pdf.data.length} bytes)`)

// Errors are typed, with the field and our request id
try {
  await hlhunt.decisions.create({ decision_type: "new_credit", product: PRODUCT, applicant: { name: "" }, facts: {} })
} catch (err) {
  if (err instanceof ValidationError) console.log(`   (a bad request throws ValidationError on '${err.param}', request ${err.requestId})`)
  else throw err
}

// Replay what your webhooks were sent
const events = await hlhunt.events.list({ type: "decision.completed", limit: 5 })
console.log(`\nLast ${events.data.length} decision.completed events: ${events.data.map((e) => e.data.result?.outcome).join(", ")}`)
console.log("\nDone. Open the dashboard's Decision Agent page to see these decisions live.")

process.on("unhandledRejection", (e) => {
  console.error(e instanceof HLHuntError ? String(e) : e)
  process.exit(1)
})
