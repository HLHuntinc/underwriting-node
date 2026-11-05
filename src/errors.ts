/**
 * Every error the SDK throws extends `HLHuntError`, so one `instanceof`
 * catches them all, and each failure mode has its own class so you can branch
 * on the type rather than on strings:
 *
 *   try { ... } catch (err) {
 *     if (err instanceof RateLimitError) await sleep(err.retryAfterMs ?? 1000)
 *     else if (err instanceof ValidationError) showFieldError(err.param, err.message)
 *     else throw err
 *   }
 *
 * API errors carry the server's `code`, `param`, `details` and `requestId`.
 * Quote the request id when you contact support: it finds the exact request
 * in our logs.
 */

export class HLHuntError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

export interface APIErrorBody {
  code?: string
  message?: string
  param?: string
  details?: Record<string, unknown>
  request_id?: string
}

/** The API answered with a non-2xx status. */
export class APIError extends HLHuntError {
  /** HTTP status. */
  readonly status: number
  /** The API's machine-readable code: `validation_error`, `not_found`, `rate_limit_exceeded`, ... */
  readonly code: string
  /** The request field the error is about, when there is one. */
  readonly param: string | undefined
  /** Machine-readable context (e.g. `{ existing_document_id }`). */
  readonly details: Record<string, unknown> | undefined
  /** Our request id: quote it to support. */
  readonly requestId: string | null
  readonly headers: Headers

  constructor(status: number, body: APIErrorBody | undefined, headers: Headers, fallbackMessage?: string) {
    const message = body?.message ?? fallbackMessage ?? `Request failed with status ${status}`
    super(message)
    this.status = status
    this.code = body?.code ?? (status >= 500 ? "internal_error" : "unknown_error")
    this.param = body?.param
    this.details = body?.details
    this.requestId = body?.request_id ?? headers.get("x-request-id")
    this.headers = headers
  }

  /** The right subclass for a response. */
  static from(status: number, body: APIErrorBody | undefined, headers: Headers, fallbackMessage?: string): APIError {
    const args = [status, body, headers, fallbackMessage] as const
    if (status === 400 || status === 422) return new ValidationError(...args)
    if (status === 401) return new AuthenticationError(...args)
    if (status === 403) return new PermissionDeniedError(...args)
    if (status === 404) return new NotFoundError(...args)
    if (status === 409) return body?.code === "idempotency_key_reused" ? new IdempotencyKeyReusedError(...args) : new ConflictError(...args)
    if (status === 429) return new RateLimitError(...args)
    if (status >= 500) return new InternalServerError(...args)
    return new APIError(...args)
  }

  override toString(): string {
    return `${this.name} [${this.status} ${this.code}]${this.param ? ` (${this.param})` : ""}: ${this.message}${this.requestId ? ` (request ${this.requestId})` : ""}`
  }
}

/** 400: the request is invalid. `param` names the field. Not retried. */
export class ValidationError extends APIError {}
/** 401: the API key is missing, malformed, revoked or expired. Not retried. */
export class AuthenticationError extends APIError {}
/** 403: the key lacks the scope this call needs (see `details` / the message). Not retried. */
export class PermissionDeniedError extends APIError {}
/** 404: no such resource for this key's organization and mode. Not retried. */
export class NotFoundError extends APIError {}
/** 409: the resource is in a state that does not allow this (e.g. already decided). Not retried, unless it is an idempotent request still in progress. */
export class ConflictError extends APIError {}
/** 409: this Idempotency-Key was used before with a different request. Use a new key. Not retried. */
export class IdempotencyKeyReusedError extends ConflictError {}
/** 5xx: our side failed. Retried automatically. */
export class InternalServerError extends APIError {}

/** 429: too many requests. Retried automatically after `Retry-After`; thrown once retries run out. */
export class RateLimitError extends APIError {
  /** How long the server asked us to wait, when it said. */
  get retryAfterMs(): number | null {
    return parseRetryAfter(this.headers.get("retry-after"))
  }
}

/** The request never got an HTTP response (DNS, TLS, connection reset). Retried automatically. */
export class APIConnectionError extends HLHuntError {
  constructor(message = "Could not reach the HL Hunt API.", options?: { cause?: unknown }) {
    super(message, options)
  }
}

/** The request took longer than `timeout`. Retried automatically. */
export class APITimeoutError extends APIConnectionError {
  constructor(timeoutMs: number) {
    super(`The request timed out after ${timeoutMs} ms.`)
  }
}

/** A webhook's signature did not verify: wrong secret, tampered body, or a replay outside the tolerance window. Respond 400. */
export class WebhookSignatureError extends HLHuntError {}

/** A `createAndWait` / `waitFor...` helper ran out of time. `last` is the latest state it saw; the work continues server-side. */
export class WaitTimeoutError<T = unknown> extends HLHuntError {
  constructor(message: string, readonly last: T) {
    super(message)
  }
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds; null when absent or unreadable. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}
