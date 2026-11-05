/**
 * hlhunt: develop against HL Hunt webhooks without a public URL.
 *
 *   npx @hlhunt/underwriting listen --forward-to http://localhost:3000/api/hlhunt/webhooks
 *   npx @hlhunt/underwriting events --limit 20
 *   npx @hlhunt/underwriting events resend evt_123 --forward-to http://localhost:3000/...
 *
 * `listen` tails your events (GET /v1/events) and POSTs each one to your
 * local endpoint exactly as a webhook would arrive: same body, same headers,
 * signed with a LOCAL secret it prints at start-up, so your verification
 * code runs unchanged. Uses HLHUNT_API_KEY (a test key is the usual choice).
 */
import { parseArgs } from "node:util"
import { randomBytes, randomUUID } from "node:crypto"
import { HLHunt } from "./client"
import { HLHuntError } from "./errors"
import { generateSignatureHeader } from "./webhooks"
import { VERSION } from "./version"
import type { WebhookEvent, WebhookEventType } from "./types"

const color = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code: number) => (s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s)
const dim = paint(2)
const green = paint(32)
const red = paint(31)
const yellow = paint(33)
const bold = paint(1)

const HELP = `hlhunt ${VERSION}: the HL Hunt Underwriting CLI

Usage:
  hlhunt listen --forward-to <url> [--events <type,...>] [--secret <whsec_...>]
  hlhunt events [--limit <n>] [--events <type,...>]
  hlhunt events resend <event id> --forward-to <url> [--secret <whsec_...>]

Options:
  --api-key <key>     Defaults to HLHUNT_API_KEY.
  --base-url <url>    Defaults to HLHUNT_BASE_URL, then https://underwriting.hlhunt.org/api.
  --forward-to <url>  Your local webhook endpoint.
  --events <list>     Only these event types (comma-separated).
  --secret <whsec_>   Sign forwarded events with this secret (default: a fresh one, printed).
  --limit <n>         How many events to list (1-100, default 20).
  -h, --help          This help.  -v, --version   The version.
`

function fail(message: string): never {
  process.stderr.write(`${red("error")} ${message}\n`)
  process.exit(1)
}

function forwardUrl(raw: string | undefined): URL {
  if (!raw) fail("--forward-to <url> is required.")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(`--forward-to is not a URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail("--forward-to must be http or https.")
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    process.stderr.write(`${yellow("warning")} forwarding to ${url.host}, not localhost. Events contain applicant data.\n`)
  }
  return url
}

async function forward(event: WebhookEvent, url: URL, secret: string): Promise<void> {
  const body = JSON.stringify(event)
  const started = Date.now()
  const label = `${dim(new Date().toLocaleTimeString())}  ${bold(event.type.padEnd(28))} ${dim(event.id)}`
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `hlhunt-cli/${VERSION}`,
        "X-Webhook-Signature": await generateSignatureHeader(body, secret),
        "X-Webhook-Id": `local_${randomUUID()}`,
        "X-Webhook-Event-Id": event.id,
        "X-Webhook-Event-Type": event.type,
        "X-Webhook-Attempt": "1",
      },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    const status = res.ok ? green(String(res.status)) : red(String(res.status))
    process.stdout.write(`${label}  -> ${status} ${dim(`${Date.now() - started} ms`)}\n`)
  } catch (error) {
    process.stdout.write(`${label}  -> ${red("failed")} ${dim(error instanceof Error ? error.message : String(error))}\n`)
  }
}

function eventTypes(raw: string | undefined): WebhookEventType[] | undefined {
  const list = raw?.split(",").map((s) => s.trim()).filter(Boolean)
  return list?.length ? (list as WebhookEventType[]) : undefined
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "api-key": { type: "string" },
      "base-url": { type: "string" },
      "forward-to": { type: "string" },
      events: { type: "string" },
      secret: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
  if (values.version) return void process.stdout.write(`${VERSION}\n`)
  const [command, sub, id] = positionals
  if (values.help || !command) return void process.stdout.write(HELP)

  let hlhunt: HLHunt
  try {
    hlhunt = new HLHunt({ apiKey: values["api-key"], baseURL: values["base-url"], appInfo: { name: "hlhunt-cli", version: VERSION } })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  const types = eventTypes(values.events)

  if (command === "listen") {
    const url = forwardUrl(values["forward-to"])
    const secret = values.secret ?? process.env.HLHUNT_LISTEN_SECRET ?? `whsec_${randomBytes(32).toString("hex")}`
    process.stdout.write(
      `${bold("Ready.")} Forwarding ${hlhunt.mode} events to ${url.href}\n` +
        `${dim("Your local signing secret (set HLHUNT_WEBHOOK_SECRET to it in your app):")}\n  ${secret}\n` +
        `${dim("Ctrl-C to stop.")}\n`,
    )
    const controller = new AbortController()
    process.once("SIGINT", () => controller.abort())
    let forwarded = 0
    try {
      for await (const event of hlhunt.events.stream({ type: types, signal: controller.signal })) {
        await forward(event, url, secret)
        forwarded++
      }
    } catch (error) {
      if (!controller.signal.aborted) fail(error instanceof HLHuntError ? error.message : String(error))
    }
    process.stdout.write(`\n${forwarded} event(s) forwarded.\n`)
    return
  }

  if (command === "events" && sub === "resend") {
    if (!id) fail("Usage: hlhunt events resend <event id> --forward-to <url>")
    const url = forwardUrl(values["forward-to"])
    const secret = values.secret ?? process.env.HLHUNT_LISTEN_SECRET ?? fail("--secret is required to resend (the secret your endpoint verifies with).")
    const page = await hlhunt.events.list({ limit: 100 })
    const event = page.data.find((e) => e.id === id) ?? fail(`Event ${id} is not among your 100 most recent events.`)
    await forward(event, url, secret)
    return
  }

  if (command === "events") {
    const limit = Number(values.limit ?? 20)
    const page = await hlhunt.events.list({ limit, type: types })
    if (page.data.length === 0) return void process.stdout.write(dim(`No ${hlhunt.mode} events in the last 30 days.\n`))
    for (const e of page.data) process.stdout.write(`${dim(e.created_at)}  ${bold(e.type.padEnd(28))} ${e.id}\n`)
    return
  }

  fail(`Unknown command: ${command}\n\n${HELP}`)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
