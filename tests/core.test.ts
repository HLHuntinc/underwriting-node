import { describe, expect, it, vi } from "vitest"
import { inspect } from "node:util"
import {
  HLHunt,
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  ConflictError,
  IdempotencyKeyReusedError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  HLHuntError,
} from "../src/index"
import { backoffDelay } from "../src/core"

const KEY = "hlh_test_abcdefghijklmnopqrstuvwxyz012345"

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } }

function mockFetch(responses: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const calls: Call[] = []
  let i = 0
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init as Call["init"] })
    const next = responses[Math.min(i++, responses.length - 1)]!
    if (next instanceof Error) throw next
    return typeof next === "function" ? next() : next.clone()
  })
  return { fetch: fn as unknown as typeof fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_abc", ...headers } })

const client = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  new HLHunt({ apiKey: KEY, baseURL: "https://api.test/api", fetch, maxRetries: 2, ...extra })

describe("construction and secrets", () => {
  it("refuses a missing or malformed key, and plain http off localhost", () => {
    const prev = process.env.HLHUNT_API_KEY
    delete process.env.HLHUNT_API_KEY
    expect(() => new HLHunt()).toThrow(/No API key/)
    expect(() => new HLHunt({ apiKey: "sk_live_123" })).toThrow(/hlh_live_ or hlh_test_/)
    expect(() => new HLHunt({ apiKey: KEY, baseURL: "http://evil.example/api" })).toThrow(/https/)
    expect(new HLHunt({ apiKey: KEY, baseURL: "http://localhost:3200/api" }).baseURL).toBe("http://localhost:3200/api")
    if (prev) process.env.HLHUNT_API_KEY = prev
  })

  it("never serialises or prints the key", () => {
    const hl = new HLHunt({ apiKey: KEY })
    expect(JSON.stringify(hl)).not.toContain(KEY)
    expect(inspect(hl, { depth: 5 })).not.toContain(KEY)
    expect(hl.mode).toBe("test")
  })

  it("refuses to run in a browser unless explicitly allowed", () => {
    const g = globalThis as Record<string, unknown>
    g.window = { document: {} }
    try {
      expect(() => new HLHunt({ apiKey: KEY })).toThrow(/browser/)
      expect(() => new HLHunt({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow()
    } finally {
      delete g.window
    }
  })
})

describe("requests", () => {
  it("sends auth, JSON, a user agent and an idempotency key on POST", async () => {
    const m = mockFetch([json(202, { id: "dec_1", status: "queued" })])
    const res = await client(m.fetch).decisions.create({ decision_type: "new_credit", product: "card", applicant: { name: "Acme" }, facts: {} }).withResponse()
    const h = m.calls[0]!.init.headers
    expect(h.Authorization).toBe(`Bearer ${KEY}`)
    expect(h["Content-Type"]).toBe("application/json")
    expect(h["Idempotency-Key"]).toMatch(/^sdk_[0-9a-f-]{36}$/)
    expect(h["User-Agent"]).toMatch(/^hlhunt-underwriting-node\/\d+\.\d+\.\d+ node\//)
    expect(res.data.id).toBe("dec_1")
    expect(res.response.requestId).toBe("req_abc")
    expect(res.response.attempts).toBe(1)
  })

  it("puts no idempotency key on GET, and encodes path segments", async () => {
    const m = mockFetch([json(200, { id: "a/b" })])
    await client(m.fetch).decisions.retrieve("a/b")
    expect(m.calls[0]!.url).toBe("https://api.test/api/v1/decisions/a%2Fb")
    expect(m.calls[0]!.init.headers["Idempotency-Key"]).toBeUndefined()
  })

  it("reads rate-limit headers", async () => {
    const m = mockFetch([json(200, { id: "d" }, { "x-ratelimit-limit": "120", "x-ratelimit-remaining": "117", "x-ratelimit-reset": "1800000000" })])
    const { response } = await client(m.fetch).decisions.retrieve("d").withResponse()
    expect(response.rateLimit).toEqual({ limit: 120, remaining: 117, resetAt: new Date(1800000000 * 1000) })
  })
})

describe("errors", () => {
  it.each([
    [400, "validation_error", ValidationError],
    [401, "unauthorized", AuthenticationError],
    [404, "not_found", NotFoundError],
    [409, "conflict", ConflictError],
    [409, "idempotency_key_reused", IdempotencyKeyReusedError],
  ])("maps %i %s to its class with code, param and request id", async (status, code, Klass) => {
    const m = mockFetch([json(status, { error: { code, message: "nope", param: "facts", request_id: "req_xyz" } })])
    const err = await client(m.fetch).decisions.retrieve("d").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Klass)
    expect(err).toBeInstanceOf(HLHuntError)
    expect(err).toMatchObject({ status, code, param: "facts", requestId: "req_xyz", message: "nope" })
    expect(m.calls).toHaveLength(1)
  })

  it("never puts the key in an error", async () => {
    const m = mockFetch([json(401, { error: { code: "unauthorized", message: "Invalid API key" } })])
    const err = (await client(m.fetch).decisions.retrieve("d").catch((e: unknown) => e)) as Error
    expect(String(err) + JSON.stringify(err) + err.stack).not.toContain(KEY)
  })
})

describe("retries", () => {
  it("retries 5xx and connection errors with the SAME idempotency key", async () => {
    const m = mockFetch([json(503, { error: { code: "internal_error", message: "x" } }), new TypeError("fetch failed"), json(201, { id: "dec_ok" })])
    const result = await client(m.fetch).decisions.create({ decision_type: "new_credit", product: "p", applicant: { name: "A" }, facts: {} }, { maxRetries: 2 }).withResponse()
    expect(result.data.id).toBe("dec_ok")
    expect(result.response.attempts).toBe(3)
    const keys = m.calls.map((c) => c.init.headers["Idempotency-Key"])
    expect(new Set(keys).size).toBe(1)
  })

  it("honours Retry-After on 429 and gives up with RateLimitError", async () => {
    vi.useFakeTimers()
    const m = mockFetch([json(429, { error: { code: "rate_limit_exceeded", message: "slow down" } }, { "retry-after": "2" })])
    const promise = client(m.fetch).decisions.retrieve("d").catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    const err = await promise
    vi.useRealTimers()
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfterMs).toBe(2000)
    expect(m.calls).toHaveLength(3)
  })

  it("retries an idempotent request still in progress, but never a real conflict", async () => {
    const inProgress = json(409, { error: { code: "conflict", message: "in progress", details: { reason: "idempotency_in_progress" } } }, { "retry-after": "0" })
    const m = mockFetch([inProgress, json(201, { id: "dec_1" })])
    expect((await client(m.fetch).decisions.create({ decision_type: "new_credit", product: "p", applicant: { name: "A" }, facts: {} })).id).toBe("dec_1")
    const real = mockFetch([json(409, { error: { code: "conflict", message: "already decided" } })])
    await expect(client(real.fetch).decisions.reportOutcome("d", { outcome: "approve" })).rejects.toBeInstanceOf(ConflictError)
    expect(real.calls).toHaveLength(1)
  })

  it("does not retry a 400", async () => {
    const m = mockFetch([json(400, { error: { code: "validation_error", message: "bad" } })])
    await expect(client(m.fetch).decisions.retrieve("d")).rejects.toBeInstanceOf(ValidationError)
    expect(m.calls).toHaveLength(1)
  })

  it("times out each attempt and surfaces APITimeoutError", async () => {
    const never = () => new Promise<Response>(() => undefined)
    const fetchImpl = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      void never()
    })) as unknown as typeof fetch
    const err = await client(fetchImpl, { timeout: 20, maxRetries: 1 }).decisions.retrieve("d").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(APITimeoutError)
    expect(err).toBeInstanceOf(APIConnectionError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("stops at once when the caller aborts, without retrying", async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })) as unknown as typeof fetch
    const p = client(fetchImpl).decisions.retrieve("d", { signal: controller.signal }).catch((e: unknown) => e)
    controller.abort(new Error("user cancelled"))
    expect(((await p) as Error).message).toBe("user cancelled")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("backs off exponentially with jitter, capped", () => {
    expect(backoffDelay(1, () => 1)).toBe(500)
    expect(backoffDelay(2, () => 0)).toBe(500)
    expect(backoffDelay(3, () => 1)).toBe(2000)
    expect(backoffDelay(10, () => 1)).toBe(8000)
  })
})

describe("pagination", () => {
  it("awaits the first page and iterates every item across pages", async () => {
    const m = mockFetch([
      json(200, { data: [{ id: "c1" }, { id: "c2" }], pagination: { page: 1, per_page: 2, total: 3, total_pages: 2 } }),
      json(200, { data: [{ id: "c3" }], pagination: { page: 2, per_page: 2, total: 3, total_pages: 2 } }),
    ])
    const hl = client(m.fetch)
    const first = await hl.cases.list({ per_page: 2 })
    expect(first.data.map((c) => c.id)).toEqual(["c1", "c2"])
    expect(first.hasNextPage()).toBe(true)
    const ids: string[] = []
    const m2 = mockFetch([
      json(200, { data: [{ id: "c1" }, { id: "c2" }], pagination: { page: 1, per_page: 2, total: 3, total_pages: 2 } }),
      json(200, { data: [{ id: "c3" }], pagination: { page: 2, per_page: 2, total: 3, total_pages: 2 } }),
    ])
    for await (const c of client(m2.fetch).cases.list({ per_page: 2, status: "approved" })) ids.push(c.id)
    expect(ids).toEqual(["c1", "c2", "c3"])
    expect(m2.calls[1]!.url).toContain("page=2")
    expect(m2.calls[1]!.url).toContain("status=approved")
  })
})

describe("waiting", () => {
  it("createAndWait polls until decided", async () => {
    const m = mockFetch([json(202, { id: "dec_1", status: "queued" }), json(200, { id: "dec_1", status: "deciding" }), json(200, { id: "dec_1", status: "decided", result: { outcome: "approve" } })])
    const d = await client(m.fetch).decisions.createAndWait({ decision_type: "new_credit", product: "p", applicant: { name: "A" }, facts: {} }, { pollInterval: 1 })
    expect(d.status).toBe("decided")
    expect(m.calls).toHaveLength(3)
  })

  it("returns at once when the decision was instant", async () => {
    const m = mockFetch([json(201, { id: "dec_1", status: "decided" })])
    await client(m.fetch).decisions.createAndWait({ decision_type: "new_credit", product: "p", applicant: { name: "A" }, facts: {} })
    expect(m.calls).toHaveLength(1)
  })

  it("times out with the last state", async () => {
    const m = mockFetch([json(202, { id: "dec_1", status: "queued" }), json(200, { id: "dec_1", status: "deciding" })])
    const err = await client(m.fetch).decisions.createAndWait({ decision_type: "new_credit", product: "p", applicant: { name: "A" }, facts: {} }, { timeout: 30, pollInterval: 10 }).catch((e: unknown) => e)
    expect((err as { last: { status: string } }).last.status).toBe("deciding")
  })
})

describe("uploads and downloads", () => {
  it("uploads a document as multipart with its fields", async () => {
    const m = mockFetch([json(201, { id: "doc_1" })])
    await client(m.fetch).cases.documents.upload("case_1", { file: { data: new Uint8Array([37, 80, 68, 70]), filename: "jan.pdf", contentType: "application/pdf" }, category: "financial", statement_id: "jan-2026" })
    const body = m.calls[0]!.init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect((body.get("file") as File).name).toBe("jan.pdf")
    expect(body.get("statement_id")).toBe("jan-2026")
    expect(m.calls[0]!.init.headers["Content-Type"]).toBeUndefined()
  })

  it("downloads a PDF as bytes with its filename", async () => {
    const m = mockFetch([new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="letter-1.pdf"' } })])
    const file = await client(m.fetch).letters.pdf("l1")
    expect(file).toMatchObject({ contentType: "application/pdf", filename: "letter-1.pdf" })
    expect(Array.from(file.data)).toEqual([37, 80, 68, 70])
  })
})
