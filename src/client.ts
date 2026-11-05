import { APIClient, type ClientOptions } from "./core"
import { constructEvent, verifySignature, generateSignatureHeader, type VerifyOptions } from "./webhooks"
import { Decisions, DecisionPolicies } from "./resources/decisions"
import { Applicants, BankLinks, Cases, Letters, Underwrite } from "./resources/cases"
import { BrandingResource, Collections, Events, PortfolioResource, Products, WebhookEndpoints } from "./resources/platform"
import type { WebhookEvent } from "./types"

/** Webhook helpers on the client: the same functions as `@hlhunt/underwriting/webhooks`. */
export class WebhooksHelper {
  constructor(readonly endpoints: WebhookEndpoints) {}

  /** Verify the signature and parse the event. Pass the RAW body. Rejects with WebhookSignatureError. */
  constructEvent(payload: string | Uint8Array | ArrayBuffer, signatureHeader: string | readonly string[] | null | undefined, secret: string | readonly string[], options?: VerifyOptions): Promise<WebhookEvent> {
    return constructEvent(payload, signatureHeader, secret, options)
  }

  verifySignature(payload: string | Uint8Array | ArrayBuffer, signatureHeader: string | readonly string[] | null | undefined, secret: string | readonly string[], options?: VerifyOptions): Promise<void> {
    return verifySignature(payload, signatureHeader, secret, options)
  }

  /** Sign a payload as HL Hunt does, for your tests. */
  generateTestHeader(payload: string, secret: string, timestamp?: number): Promise<string> {
    return generateSignatureHeader(payload, secret, timestamp)
  }

  // Endpoint management, as `hlhunt.webhooks.create(...)` etc.
  create: WebhookEndpoints["create"] = (...args) => this.endpoints.create(...args)
  list: WebhookEndpoints["list"] = (...args) => this.endpoints.list(...args)
  del: WebhookEndpoints["del"] = (...args) => this.endpoints.del(...args)
}

/**
 * The HL Hunt Underwriting API.
 *
 *   import { HLHunt } from "@hlhunt/underwriting"
 *   const hlhunt = new HLHunt()            // reads HLHUNT_API_KEY
 *
 *   const decision = await hlhunt.decisions.createAndWait({ ... })
 *   for await (const c of hlhunt.cases.list({ status: "approved" })) console.log(c.id)
 */
export class HLHunt {
  /** `live` or `test`, from your key. */
  readonly mode: "live" | "test"
  readonly underwrite: Underwrite
  readonly cases: Cases
  readonly decisions: Decisions
  readonly decisionPolicies: DecisionPolicies
  readonly letters: Letters
  readonly applicants: Applicants
  readonly bankLinks: BankLinks
  readonly portfolio: PortfolioResource
  readonly collections: Collections
  readonly products: Products
  readonly branding: BrandingResource
  readonly webhooks: WebhooksHelper
  readonly events: Events
  readonly #client: APIClient

  constructor(options: ClientOptions = {}) {
    const client = new APIClient(options)
    this.#client = client
    this.mode = client.mode
    this.cases = new Cases(client)
    this.underwrite = new Underwrite(client, this.cases)
    this.decisions = new Decisions(client)
    this.decisionPolicies = new DecisionPolicies(client)
    this.letters = new Letters(client)
    this.applicants = new Applicants(client)
    this.bankLinks = new BankLinks(client)
    this.portfolio = new PortfolioResource(client)
    this.collections = new Collections(client)
    this.products = new Products(client)
    this.branding = new BrandingResource(client)
    this.webhooks = new WebhooksHelper(new WebhookEndpoints(client))
    this.events = new Events(client)
  }

  get baseURL(): string {
    return this.#client.baseURL
  }

  /** Never serialises the key. */
  toJSON(): Record<string, unknown> {
    return this.#client.toJSON()
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `HLHunt ${JSON.stringify(this.toJSON())}`
  }
}
