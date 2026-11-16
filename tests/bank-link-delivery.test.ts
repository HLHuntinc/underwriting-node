import { describe, expect, it, vi } from "vitest"
import { HLHunt, type BankLink, type BankLinkCreateParams } from "../src/index"

describe("bank link delivery", () => {
  it.each(["link_only", "email", undefined] as const)("forwards %s delivery and retains idempotency on retry", async (delivery) => {
    const response: BankLink = {
      id: "link-1", case_id: "case-1", status: "pending",
      url: "https://portal.test/bank-verification/private", expires_at: "2026-11-23T00:00:00Z",
      delivery: delivery ?? "email", delivery_status: "suppressed",
    }
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 201 }))
    const hl = new HLHunt({ apiKey: "hlh_test_abcdefghijklmnopqrstuvwxyz012345", baseURL: "https://api.test/api", fetch })
    const params: BankLinkCreateParams = { case_id: "case-1", ...(delivery ? { delivery } : {}) }
    const link = await hl.bankLinks.create(params, { idempotencyKey: "case-1-bank-link-1" })
    expect(link).toEqual(response)
    expect(fetch).toHaveBeenCalledTimes(2)
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe("https://api.test/api/v1/bank-link")
      expect(JSON.parse(init.body)).toEqual(params)
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("case-1-bank-link-1")
    }
  })
})
