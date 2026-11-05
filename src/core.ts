/**
 * The request engine every resource goes through.
 *
 *  - Auth: `Authorization: Bearer <key>`. The key never appears in an error,
 *    a log line, `JSON.stringify(client)` or `util.inspect(client)`.
 *  - Idempotency: every POST / PATCH carries an `Idempotency-Key`, generated
 *    once per call and reused on every retry, so a retried create can never
 *    create twice. Pass your own to make a call idempotent across processes.
 *  - Retries: connection errors, timeouts, 408, 429, 5xx, and a 409 for an
 *    idempotent request still in progress. Exponential backoff with full
 *    jitter, honouring `Retry-After`. Never a 4xx that would fail again.
 *  - Timeouts per attempt via AbortController; your own `signal` cancels
 *    immediately and is never retried.
 *  - Metadata: `await call.withResponse()` gives the request id, status,
 *    headers and rate-limit state alongside the data.
 */
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  HLHuntError,
  parseRetryAfter,
  type APIErrorBody,
} from "./errors"
import { VERSION } from "./version"

export const DEFAULT_BASE_URL = "https://underwriting.hlhunt.org/api"
export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_RETRIES = 2
const MAX_RETRY_DELAY_MS = 8_000
const MAX_RETRY_AFTER_MS = 60_000
const KEY_PATTERN = /^hlh_(live|test)_[A-Za-z0-9_-]{16,}$/

export interface ClientOptions {
  /** Your secret API key, `hlh_live_...` or `hlh_test_...`. Defaults to `process.env.HLHUNT_API_KEY`. */
  apiKey?: string
  /** Defaults to `process.env.HLHUNT_BASE_URL`, then https://underwriting.hlhunt.org/api. */
  baseURL?: string
  /** Per-attempt timeout in ms. Default 60000. */
  timeout?: number
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number
  /** A custom fetch (proxies, instrumentation, tests). Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Extra headers on every request. */
  defaultHeaders?: Record<string, string>
  /** Identify your integration in our logs: `{ name: "acme-platform", version: "2.3.0" }`. */
  appInfo?: { name: string; version?: string }
  /**
   * Your API key is a secret that can move credit decisions. The SDK refuses to
   * run in a browser unless you set this, and you almost certainly should not.
   */
  dangerouslyAllowBrowser?: boolean
}

export interface RequestOptions {
  /** Use your own Idempotency-Key (max 255 chars). Same key + same body = the original response, once. */
  idempotencyKey?: string
  /** Override the per-attempt timeout for this call. */
  timeout?: number
  /** Override retries for this call. */
  maxRetries?: number
  /** Cancel the call. A cancelled call is never retried. */
  signal?: AbortSignal
  /** Extra headers for this call. */
  headers?: Record<string, string>
}

export interface RateLimitInfo {
  limit: number
  remaining: number
  /** When the window resets. */
  resetAt: Date
}

export interface ResponseMeta {
  status: number
  /** Our request id: quote it to support. */
  requestId: string | null
  headers: Headers
  rateLimit: RateLimitInfo | null
  /** How many attempts the call took (1 = no retry). */
  attempts: number
}

export interface FinalRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  path: string
  query?: Record<string, string | number | boolean | null | undefined | readonly string[]>
  body?: unknown
  /** A multipart body (uploads). Mutually exclusive with `body`. */
  form?: FormData
  /** Binary responses (PDFs). */
  responseType?: "json" | "binary"
}

/** A file downloaded from the API. */
export interface BinaryFile {
  data: Uint8Array
  contentType: string
  filename: string | null
}

/**
 * The value every SDK method returns: await it for the data, or call
 * `.withResponse()` for the data plus request id, status and rate limit.
 */
export class APIPromise<T> implements PromiseLike<T> {
  readonly #inner: Promise<{ data: T; response: ResponseMeta }>

  constructor(inner: Promise<{ data: T; response: ResponseMeta }>) {
    this.#inner = inner
    // An APIPromise nobody awaits must not crash the process with an unhandled rejection
    // on its own: the caller who awaits it still gets the error.
    inner.catch(() => undefined)
  }

  withResponse(): Promise<{ data: T; response: ResponseMeta }> {
    return this.#inner
  }

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#inner.then((r) => r.data).then(onfulfilled, onrejected)
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.then(undefined, onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then().finally(onfinally)
  }

  get [Symbol.toStringTag](): string {
    return "APIPromise"
  }
}

export interface Pagination {
  page: number
  per_page: number
  total: number
  total_pages: number
}

export interface PageParams {
  page?: number
  per_page?: number
}

/** One page of a list. `for await` over the call itself walks every page. */
export class Page<T> {
  readonly #next: (page: number) => APIPromise<Page<T>>

  constructor(
    readonly data: T[],
    readonly pagination: Pagination,
    next: (page: number) => APIPromise<Page<T>>,
  ) {
    this.#next = next
  }

  hasNextPage(): boolean {
    return this.pagination.page < this.pagination.total_pages
  }

  getNextPage(): APIPromise<Page<T>> {
    if (!this.hasNextPage()) throw new HLHuntError("There is no next page. Check hasNextPage() first.")
    return this.#next(this.pagination.page + 1)
  }
}

/** A list call: await it for the first page, or `for await (const item of call)` for every item on every page. */
export class PagePromise<T> extends APIPromise<Page<T>> implements AsyncIterable<T> {
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page: Page<T> = await this
    for (;;) {
      for (const item of page.data) yield item
      if (!page.hasNextPage()) return
      page = await page.getNextPage()
    }
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof (window as { document?: unknown }).document !== "undefined"
}

function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined
}

function randomId(): string {
  return globalThis.crypto.randomUUID()
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })

/** Exponential backoff with full jitter, in ms: attempt 1 -> up to 0.5 s, 2 -> 1 s, 3 -> 2 s ... capped at 8 s. */
export function backoffDelay(retry: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** (retry - 1))
  return Math.round(ceiling * (0.5 + random() / 2))
}

function readRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = Number(headers.get("x-ratelimit-limit"))
  const remaining = Number(headers.get("x-ratelimit-remaining"))
  const reset = Number(headers.get("x-ratelimit-reset"))
  if (!Number.isFinite(limit) || !headers.has("x-ratelimit-limit")) return null
  return { limit, remaining: Number.isFinite(remaining) ? remaining : 0, resetAt: new Date((Number.isFinite(reset) ? reset : 0) * 1000) }
}

function filenameFrom(disposition: string | null): string | null {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export class APIClient {
  readonly baseURL: string
  readonly timeout: number
  readonly maxRetries: number
  readonly #apiKey: string
  readonly #fetch: typeof fetch
  readonly #defaultHeaders: Record<string, string>
  readonly #userAgent: string

  constructor(options: ClientOptions = {}) {
    if (isBrowser() && !options.dangerouslyAllowBrowser) {
      throw new HLHuntError(
        "The HL Hunt SDK is running in a browser, which would expose your secret API key to every visitor. Call the API from your server. (To override, set dangerouslyAllowBrowser: true.)",
      )
    }
    const apiKey = options.apiKey ?? env("HLHUNT_API_KEY")
    if (!apiKey) throw new HLHuntError("No API key. Pass { apiKey } or set the HLHUNT_API_KEY environment variable.")
    if (!KEY_PATTERN.test(apiKey)) {
      throw new HLHuntError("That does not look like an HL Hunt API key: keys start with hlh_live_ or hlh_test_.")
    }
    this.#apiKey = apiKey
    this.baseURL = (options.baseURL ?? env("HLHUNT_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    if (!/^https:\/\//.test(this.baseURL) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(this.baseURL)) {
      throw new HLHuntError("baseURL must use https (plain http is accepted only for localhost).")
    }
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
    const f = options.fetch ?? globalThis.fetch
    if (typeof f !== "function") throw new HLHuntError("No fetch available. Use Node 20+ or pass { fetch }.")
    this.#fetch = f.bind(globalThis)
    this.#defaultHeaders = { ...(options.defaultHeaders ?? {}) }
    const runtime = typeof process !== "undefined" && process.versions?.node ? `node/${process.versions.node}` : "runtime/unknown"
    const app = options.appInfo ? ` ${options.appInfo.name}${options.appInfo.version ? `/${options.appInfo.version}` : ""}` : ""
    this.#userAgent = `hlhunt-underwriting-node/${VERSION} ${runtime}${app}`
  }

  /** `live` or `test`, from the key. */
  get mode(): "live" | "test" {
    return this.#apiKey.startsWith("hlh_live_") ? "live" : "test"
  }

  /** Never serialise the key. */
  toJSON(): Record<string, unknown> {
    return { baseURL: this.baseURL, mode: this.mode, timeout: this.timeout, maxRetries: this.maxRetries }
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `HLHunt ${JSON.stringify(this.toJSON())}`
  }

  request<T>(req: FinalRequest, options: RequestOptions = {}): APIPromise<T> {
    return new APIPromise(this.#run<T>(req, options))
  }

  page<T>(path: string, query: Record<string, unknown> & PageParams, options?: RequestOptions): PagePromise<T> {
    const fetchPage = (page: number): APIPromise<Page<T>> =>
      new APIPromise(
        this.#run<{ data: T[]; pagination: Pagination }>({ method: "GET", path, query: { ...query, page } as FinalRequest["query"] }, options ?? {}).then(
          ({ data, response }) => ({ data: new Page<T>(data.data, data.pagination, fetchPage), response }),
        ),
      )
    const first = fetchPage(query.page ?? 1)
    return new PagePromise(first.withResponse())
  }

  #url(path: string, query?: FinalRequest["query"]): string {
    const url = new URL(this.baseURL + path)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value))
    }
    return url.toString()
  }

  async #run<T>(req: FinalRequest, options: RequestOptions): Promise<{ data: T; response: ResponseMeta }> {
    const mutating = req.method === "POST" || req.method === "PATCH"
    if (options.idempotencyKey !== undefined && (options.idempotencyKey.length === 0 || options.idempotencyKey.length > 255)) {
      throw new HLHuntError("idempotencyKey must be 1 to 255 characters.")
    }
    const idempotencyKey = mutating ? (options.idempotencyKey ?? `sdk_${randomId()}`) : undefined
    const maxRetries = Math.max(0, options.maxRetries ?? this.maxRetries)
    const timeout = options.timeout ?? this.timeout
    const url = this.#url(req.path, req.query)

    const headers: Record<string, string> = {
      Accept: req.responseType === "binary" ? "application/pdf, application/json" : "application/json",
      "User-Agent": this.#userAgent,
      "X-HLHunt-Client": `node/${VERSION}`,
      ...this.#defaultHeaders,
      ...(options.headers ?? {}),
      Authorization: `Bearer ${this.#apiKey}`,
    }
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey
    if (req.body !== undefined && !req.form) headers["Content-Type"] = "application/json"
    const body = req.form ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined)

    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new HLHuntError("The request was cancelled.")
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener("abort", onAbort, { once: true })
      const timer = setTimeout(() => controller.abort(new APITimeoutError(timeout)), timeout)

      let response: Response | undefined
      let failure: HLHuntError | undefined
      try {
        response = await this.#fetch(url, { method: req.method, headers, body, signal: controller.signal })
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error
        failure = controller.signal.reason instanceof APITimeoutError ? controller.signal.reason : new APIConnectionError(undefined, { cause: error })
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
      }

      if (response && response.ok) {
        const meta: ResponseMeta = {
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          headers: response.headers,
          rateLimit: readRateLimit(response.headers),
          attempts: attempt,
        }
        if (req.responseType === "binary") {
          const data: BinaryFile = {
            data: new Uint8Array(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            filename: filenameFrom(response.headers.get("content-disposition")),
          }
          return { data: data as T, response: meta }
        }
        const text = await response.text()
        let data: unknown = null
        if (text) {
          try {
            data = JSON.parse(text)
          } catch {
            throw new APIError(response.status, undefined, response.headers, "The API returned a body that is not JSON.")
          }
        }
        return { data: data as T, response: meta }
      }

      let retryAfterMs: number | null = null
      if (response) {
        let parsed: { error?: APIErrorBody } | undefined
        try {
          parsed = (await response.json()) as { error?: APIErrorBody }
        } catch {
          parsed = undefined
        }
        failure = APIError.from(response.status, parsed?.error, response.headers)
        retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
      }

      const retryable = this.#shouldRetry(failure!, req.method, Boolean(idempotencyKey))
      if (!retryable || attempt > maxRetries) throw failure
      const delay = retryAfterMs !== null ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : backoffDelay(attempt)
      await sleep(delay, options.signal)
    }
  }

  #shouldRetry(error: HLHuntError, method: FinalRequest["method"], hasIdempotencyKey: boolean): boolean {
    // A POST/PATCH without a key could double-apply; the SDK always sends one, but be explicit.
    const safeToRepeat = method === "GET" || method === "PUT" || method === "DELETE" || hasIdempotencyKey
    if (!safeToRepeat) return false
    if (error instanceof APIConnectionError) return true
    if (!(error instanceof APIError)) return false
    if (error.status === 408 || error.status === 429 || error.status >= 500) return true
    return error.status === 409 && error.details?.reason === "idempotency_in_progress"
  }
}

export interface WaitOptions {
  /** Give up after this long (ms). The work continues server-side; you get a WaitTimeoutError with the last state. Default 180000. */
  timeout?: number
  /** First poll interval (ms); grows by half each poll up to 5000. Default 1000. */
  pollInterval?: number
  signal?: AbortSignal
}

/** Poll `fetchOnce` until `done` says so, backing off gently. Throws WaitTimeoutError (from the caller) on timeout. */
export async function pollUntil<T>(
  fetchOnce: () => Promise<T>,
  done: (value: T) => boolean,
  options: WaitOptions,
  onTimeout: (last: T) => Error,
): Promise<T> {
  const deadline = Date.now() + (options.timeout ?? 180_000)
  let interval = options.pollInterval ?? 1_000
  for (;;) {
    const value = await fetchOnce()
    if (done(value)) return value
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw onTimeout(value)
    await sleep(Math.min(interval, remaining), options.signal)
    interval = Math.min(5_000, Math.round(interval * 1.5))
  }
}
