import { toBlob, type Uploadable } from "./cases"
import { pollUntil, type APIClient, type APIPromise, type PagePromise, type PageParams, type RequestOptions, type WaitOptions } from "../core"
import { WaitTimeoutError } from "../errors"
import type {
  Decision,
  DecisionDocument,
  DecisionFactsParams,
  DecisionCreateParams,
  DecisionListParams,
  DecisionOutcomeParams,
  DecisionPolicy,
  DecisionPolicyUpdateParams,
} from "../types"

const enc = encodeURIComponent

/**
 * The Decision Agent: credit decisions inside your own policy.
 *
 *   const decision = await hlhunt.decisions.createAndWait({ decision_type: "new_credit", product: "business_card", applicant: { name: "Acme LLC" }, facts: { requested_amount: 25000, credit_score: 712 } })
 *   if (decision.result?.outcome === "approve") ...
 *   await hlhunt.decisions.reportOutcome(decision.id, { outcome: "approve", amount: 25000 })
 */
export class DecisionDocuments {
  constructor(private readonly client: APIClient) {}
  async list(id: string, options?: RequestOptions): Promise<DecisionDocument[]> {
    const result = await this.client.request<{ data: DecisionDocument[] }>({ method: "GET", path: `/v1/decisions/${enc(id)}/documents` }, options)
    return result.data
  }
  upload(id: string, params: { file: Uploadable; kind?: "bank_statements" | "card_statements" | "financial_statements" | "tax_return" | "other" }, options?: RequestOptions): APIPromise<Decision> {
    const { blob, filename } = toBlob(params.file)
    const form = new FormData()
    form.append("file", blob, filename)
    if (params.kind) form.append("kind", params.kind)
    return this.client.request({ method: "POST", path: `/v1/decisions/${enc(id)}/documents`, form }, options)
  }
}

export class Decisions {
  readonly documents: DecisionDocuments
  constructor(private readonly client: APIClient) { this.documents = new DecisionDocuments(client) }

  /**
   * Submit a request. Missing material evidence remains awaiting_evidence. Knock-outs and test
   * scenarios come back decided (`status: "decided"`); everything else is
   * `queued`/`deciding` and finishes in the `decision.completed` webhook, or
   * use `createAndWait`.
   */
  create(params: DecisionCreateParams, options?: RequestOptions): APIPromise<Decision> {
    return this.client.request({ method: "POST", path: "/v1/decisions", body: params }, options)
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<Decision> {
    return this.client.request({ method: "GET", path: `/v1/decisions/${enc(id)}` }, options)
  }

  /** Newest first. `for await (const d of hlhunt.decisions.list())` walks every page. */
  list(params: DecisionListParams & PageParams = {}, options?: RequestOptions): PagePromise<Decision> {
    return this.client.page("/v1/decisions", params as Record<string, unknown>, options)
  }

  /** Supply specific missing facts without creating another decision. */
  addFacts(id: string, params: DecisionFactsParams, options?: RequestOptions): APIPromise<Decision> {
    return this.client.request({ method: "POST", path: `/v1/decisions/${enc(id)}/facts`, body: params }, options)
  }

  /**
   * Your final call. An adverse outcome (decline, counter, reduce, close)
   * issues the applicant's letter under your branding. Recorded once.
   */
  reportOutcome(id: string, params: DecisionOutcomeParams, options?: RequestOptions): APIPromise<Decision> {
    return this.client.request({ method: "POST", path: `/v1/decisions/${enc(id)}/outcome`, body: params }, options)
  }

  /** Wait until a decision is `decided`, `failed`, or needs information (`awaiting_evidence`). */
  async waitFor(id: string, options: WaitOptions & RequestOptions = {}): Promise<Decision> {
    return pollUntil(
      () => this.retrieve(id, options),
      (d) => d.status === "decided" || d.status === "failed" || d.status === "awaiting_evidence",
      options,
      (last) => new WaitTimeoutError(`Decision ${id} was still ${last.status} after waiting. It continues server-side; use the webhook or retrieve() later.`, last),
    )
  }

  /** Submit and wait for the result (typically 10-60 s for an agent decision; instant for policy decisions). */
  async createAndWait(params: DecisionCreateParams, options: WaitOptions & RequestOptions = {}): Promise<Decision> {
    const created = await this.create(params, options)
    if (created.status === "decided" || created.status === "failed" || created.status === "awaiting_evidence") return created
    return this.waitFor(created.id, options)
  }
}

/** The credit policy the Decision Agent applies, per product and decision type. */
export class DecisionPolicies {
  constructor(private readonly client: APIClient) {}

  /** Every active policy, plus the defaults for decision types you have not configured. */
  async list(options?: RequestOptions): Promise<DecisionPolicy[]> {
    const body = await this.client.request<{ data: DecisionPolicy[] }>({ method: "GET", path: "/v1/decision-policies" }, options)
    return body.data
  }

  /** Save a policy as a new version. Earlier decisions keep the version they were decided under. */
  update(params: DecisionPolicyUpdateParams, options?: RequestOptions): APIPromise<DecisionPolicy> {
    return this.client.request({ method: "PUT", path: "/v1/decision-policies", body: params }, options)
  }
}
