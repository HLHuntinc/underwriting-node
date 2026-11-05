import { describe, expect, it } from "vitest"
import { createHmac } from "node:crypto"
import { constructEvent, generateSignatureHeader, isEvent, verifySignature, WebhookSignatureError } from "../src/index"
import { parseSignatureHeader } from "../src/webhooks"

const SECRET = "whsec_" + "a".repeat(64)
const NOW = 1_800_000_000
const body = JSON.stringify({ id: "evt_1", type: "decision.completed", livemode: false, environment: "test", created_at: "2026-11-06T00:00:00.000Z", data: { id: "dec_1", status: "decided", result: { outcome: "approve" } } })

/** Exactly how the HL Hunt server signs (server/services/webhooks/signing.ts). */
const serverSign = (secret: string, raw: string, ts: number) => `timestamp=${ts},sig=${createHmac("sha256", secret).update(`${ts}:${raw}`).digest("hex")}`

describe("webhook verification", () => {
  it("accepts a signature produced the way the server signs", async () => {
    const event = await constructEvent(body, serverSign(SECRET, body, NOW), SECRET, { now: NOW })
    expect(event.type).toBe("decision.completed")
    if (isEvent(event, "decision.completed")) expect(event.data.id).toBe("dec_1")
  })

  it("accepts Buffer / Uint8Array / ArrayBuffer bodies and header arrays", async () => {
    const header = serverSign(SECRET, body, NOW)
    const bytes = new TextEncoder().encode(body)
    await expect(verifySignature(Buffer.from(body), header, SECRET, { now: NOW })).resolves.toBeUndefined()
    await expect(verifySignature(bytes, [header], SECRET, { now: NOW })).resolves.toBeUndefined()
    await expect(verifySignature(bytes.buffer.slice(0), header, SECRET, { now: NOW })).resolves.toBeUndefined()
  })

  it("matches the SDK's own signer byte for byte", async () => {
    expect(await generateSignatureHeader(body, SECRET, NOW)).toBe(serverSign(SECRET, body, NOW))
  })

  it("rejects a changed body, a wrong secret, and a missing or malformed header", async () => {
    const header = serverSign(SECRET, body, NOW)
    await expect(verifySignature(body.replace("approve", "decline"), header, SECRET, { now: NOW })).rejects.toThrow(/does not match/)
    await expect(verifySignature(body, header, "whsec_wrong", { now: NOW })).rejects.toBeInstanceOf(WebhookSignatureError)
    await expect(verifySignature(body, undefined, SECRET, { now: NOW })).rejects.toThrow(/Missing/)
    await expect(verifySignature(body, "sig=abc", SECRET, { now: NOW })).rejects.toThrow(/Malformed/)
    await expect(verifySignature(body, [header, header], SECRET, { now: NOW })).rejects.toThrow(/exactly one/)
  })

  it("rejects a replay outside the tolerance, in either direction", async () => {
    const header = serverSign(SECRET, body, NOW)
    await expect(verifySignature(body, header, SECRET, { now: NOW + 301 })).rejects.toThrow(/tolerance/)
    await expect(verifySignature(body, header, SECRET, { now: NOW - 301 })).rejects.toThrow(/tolerance/)
    await expect(verifySignature(body, header, SECRET, { now: NOW + 600, toleranceSeconds: 900 })).resolves.toBeUndefined()
  })

  it("verifies against either secret during a rotation", async () => {
    const newSecret = "whsec_" + "b".repeat(64)
    await expect(verifySignature(body, serverSign(newSecret, body, NOW), [SECRET, newSecret], { now: NOW })).resolves.toBeUndefined()
  })

  it("refuses parsed JSON instead of the raw body", async () => {
    await expect(verifySignature(JSON.parse(body) as never, serverSign(SECRET, body, NOW), SECRET, { now: NOW })).rejects.toThrow(/raw body/)
  })

  it("rejects a signed body that is not an HL Hunt event", async () => {
    const other = JSON.stringify({ hello: "world" })
    await expect(constructEvent(other, serverSign(SECRET, other, NOW), SECRET, { now: NOW })).rejects.toThrow(/not an HL Hunt event/)
  })

  it("parses the header leniently", () => {
    expect(parseSignatureHeader(" timestamp=1800000000 , sig=ABCDEF ")).toEqual({ timestamp: "1800000000", signatures: ["abcdef"] })
  })
})
