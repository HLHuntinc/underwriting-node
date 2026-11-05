/**
 * Webhook signature verification. Standalone: import it without a client,
 * from any runtime with Web Crypto (Node 20+, Vercel/Next edge, Cloudflare
 * Workers, Deno, Bun).
 *
 *   import { constructEvent } from "@hlhunt/underwriting/webhooks"
 *
 *   export async function POST(req: Request) {
 *     const event = await constructEvent(await req.text(), req.headers.get("x-webhook-signature"), process.env.HLHUNT_WEBHOOK_SECRET!)
 *     if (event.type === "decision.completed") console.log(event.data.result?.outcome)
 *     return new Response(null, { status: 200 })
 *   }
 *
 * The scheme: `X-Webhook-Signature: timestamp=<unix seconds>,sig=<hex>`, where
 * sig = HMAC-SHA256(secret, `${timestamp}:${rawBody}`). Verify the RAW body,
 * exactly as received: re-serialising parsed JSON changes the bytes.
 * Signatures older (or newer) than the tolerance are refused, so a captured
 * request cannot be replayed later.
 */
import { WebhookSignatureError } from "./errors"
import type { WebhookEvent } from "./types"

export const SIGNATURE_HEADER = "x-webhook-signature"
export const EVENT_ID_HEADER = "x-webhook-event-id"
export const EVENT_TYPE_HEADER = "x-webhook-event-type"
export const DEFAULT_TOLERANCE_SECONDS = 300

export interface VerifyOptions {
  /** Max age (and future skew) of a signature, in seconds. Default 300. */
  toleranceSeconds?: number
  /** The current time in unix seconds, for tests. */
  now?: number
}

type Payload = string | Uint8Array | ArrayBuffer

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

function bytesOf(payload: Payload): Uint8Array {
  if (typeof payload === "string") return encoder.encode(payload)
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  throw new WebhookSignatureError("The webhook payload must be the raw body: a string, Uint8Array/Buffer or ArrayBuffer, not parsed JSON.")
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new WebhookSignatureError("Web Crypto is not available in this runtime (Node 20+ required).")
  return s
}

async function hmacHex(secret: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const prefix = encoder.encode(`${timestamp}:`)
  const message = new Uint8Array(prefix.length + body.length)
  message.set(prefix, 0)
  message.set(body, prefix.length)
  const digest = new Uint8Array(await subtle().sign("HMAC", key, message))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Constant-time string comparison: the time taken does not depend on where the strings differ. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `timestamp=...,sig=...` (spaces allowed; several `sig` values accepted, for secret rotation). */
export function parseSignatureHeader(header: string): { timestamp: string; signatures: string[] } {
  let timestamp = ""
  const signatures: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "timestamp" || key === "t") timestamp = value
    else if (key === "sig" || key === "v1") signatures.push(value.toLowerCase())
  }
  return { timestamp, signatures }
}

function headerValue(header: string | readonly string[] | null | undefined): string {
  if (Array.isArray(header)) {
    if (header.length !== 1) throw new WebhookSignatureError("Expected exactly one X-Webhook-Signature header.")
    return String(header[0])
  }
  if (typeof header !== "string" || header.trim() === "") throw new WebhookSignatureError("Missing X-Webhook-Signature header.")
  return header
}

/**
 * Verify a signature. Resolves when it is valid; rejects with
 * WebhookSignatureError (respond 400) when it is not.
 *
 * `secrets` may be one secret or several (during a rotation, verify against
 * both the old and the new secret).
 */
export async function verifySignature(
  payload: Payload,
  header: string | readonly string[] | null | undefined,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): Promise<void> {
  const list = (Array.isArray(secrets) ? secrets : [secrets]).filter((s): s is string => typeof s === "string" && s.length > 0)
  if (list.length === 0) throw new WebhookSignatureError("No webhook signing secret configured.")
  const { timestamp, signatures } = parseSignatureHeader(headerValue(header))
  if (!/^\d{9,11}$/.test(timestamp) || signatures.length === 0) {
    throw new WebhookSignatureError("Malformed X-Webhook-Signature header: expected timestamp=<seconds>,sig=<hex>.")
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > tolerance) {
    throw new WebhookSignatureError(`The signature timestamp is outside the ${tolerance}s tolerance: a delayed or replayed request.`)
  }
  const body = bytesOf(payload)
  for (const secret of list) {
    const expected = await hmacHex(secret, timestamp, body)
    // Compare against every presented signature, without short-circuiting on the first byte.
    let match = false
    for (const signature of signatures) match = timingSafeEqual(expected, signature) || match
    if (match) return
  }
  throw new WebhookSignatureError("The webhook signature does not match: wrong secret, or the body was changed.")
}

/**
 * Verify, then parse. Rejects with WebhookSignatureError on any problem.
 * Narrow on `event.type` and `event.data` is typed.
 */
export async function constructEvent(
  payload: Payload,
  header: string | readonly string[] | null | undefined,
  secrets: string | readonly string[],
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  await verifySignature(payload, header, secrets, options)
  let parsed: unknown
  try {
    parsed = JSON.parse(typeof payload === "string" ? payload : decoder.decode(bytesOf(payload)))
  } catch {
    throw new WebhookSignatureError("The webhook body is signed but is not valid JSON.")
  }
  const event = parsed as Partial<WebhookEvent>
  if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.type !== "string" || !("data" in event)) {
    throw new WebhookSignatureError("The webhook body is not an HL Hunt event.")
  }
  return event as WebhookEvent
}

/**
 * Sign a payload the way HL Hunt does, for your own tests and for
 * `hlhunt listen`, which forwards events to localhost signed with a local secret.
 */
export async function generateSignatureHeader(payload: Payload, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const ts = String(Math.floor(timestamp))
  return `timestamp=${ts},sig=${await hmacHex(secret, ts, bytesOf(payload))}`
}

/** A type guard: `if (isEvent(event, "decision.completed")) event.data.result`. */
export function isEvent<K extends WebhookEvent["type"]>(event: WebhookEvent, type: K): event is Extract<WebhookEvent, { type: K }> {
  return event.type === type
}
