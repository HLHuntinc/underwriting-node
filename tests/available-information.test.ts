import { describe, expect, it, vi } from "vitest"
import { HLHunt } from "../src/index"
const key = "hlh_test_abcdefghijklmnopqrstuvwxyz012345"
function setup(reply: (url: string, init?: RequestInit) => unknown) {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => new Response(JSON.stringify(reply(String(url), init)), { status: 200, headers: { "Content-Type": "application/json" } }))
  return { fetch, hl: new HLHunt({ apiKey: key, baseURL: "https://api.test/api", fetch: fetch as typeof globalThis.fetch }) }
}
describe("available information", () => {
  it("sends sparse applications with unknown amount unchanged", async () => {
    const { hl, fetch } = setup(() => ({ id: "case-1", amount: null }))
    await hl.underwrite.create({ product_slug: "biz-term-loan", applicant: { name: "Example LLC", email: "owner@example.test" }, requested_amount: null, business_id: "business-1", auto_match_email: false })
    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body))
    expect(body.requested_amount).toBeNull()
    expect(body).not.toHaveProperty("revenue")
  })
  it("adds facts and documents to the same case, and reads current state", async () => {
    const { hl, fetch } = setup((url) => url.endsWith("/facts") ? { case_id: "case-1", analysis_id: "job-2", status: "queued" } : { id: "case-1" })
    await hl.cases.addFacts("case-1", { facts: { processing_volume: 18000, processor_terminated: null }, website: "https://example.test" })
    await hl.cases.documents.upload("case-1", { file: { data: new Uint8Array([1]), filename: "processor.pdf", contentType: "application/pdf" }, category: "processing" })
    await hl.cases.retrieve("case-1")
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://api.test/api/v1/cases/case-1/facts", "https://api.test/api/v1/cases/case-1/documents", "https://api.test/api/v1/cases/case-1"])
    expect((fetch.mock.calls[1]![1]?.body as FormData).get("category")).toBe("processing")
  })
  it("returns missing-information requests without polling until timeout", async () => {
    const { hl, fetch } = setup(() => ({ id: "decision-1", status: "awaiting_evidence", information_requests: [{ id: "decision-1:fact:current_limit" }] }))
    const result = await hl.decisions.createAndWait({ product: "merchant", decision_type: "new_credit", applicant: { name: "Example LLC" } })
    expect(result.status).toBe("awaiting_evidence")
    expect(fetch).toHaveBeenCalledTimes(1)
    await hl.decisions.addFacts(result.id, { facts: { current_limit: 10000 } })
    await hl.decisions.documents.upload(result.id, { file: { data: new Uint8Array([1]), filename: "october.pdf" }, kind: "bank_statements" })
    expect(fetch.mock.calls[2]![0]).toContain("/decisions/decision-1/documents")
  })
  it("recovers current state for duplicate and out-of-order notification signals", async () => {
    const { hl, fetch } = setup(() => ({ id: "case-1", available_assessment: { analysis_id: "latest", information_requests: [] } }))
    const seen = new Set<string>()
    let notification: unknown
    // Call after signature verification and durable event receipt. Serialize by case.
    async function accept(event: { id: string; data: { case_id: string }; created_at: string }) {
      if (seen.has(event.id)) return
      notification = await hl.cases.retrieve(event.data.case_id)
      seen.add(event.id)
    }
    const newer = { id: "event-2", data: { case_id: "case-1" }, created_at: "2026-11-16T12:00:02Z" }
    await accept(newer)
    await accept(newer)
    await accept({ ...newer, id: "event-1", created_at: "2026-11-16T12:00:01Z" })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(notification).toMatchObject({ available_assessment: { analysis_id: "latest", information_requests: [] } })
  })
})
