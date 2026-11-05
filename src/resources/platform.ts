import { type APIClient, type APIPromise, type PagePromise, type PageParams, type RequestOptions } from "../core"
import type {
  Branding,
  BrandingUpdateParams,
  CollectionActivity,
  CollectionActivityParams,
  CollectionCase,
  CollectionEscalateParams,
  CollectionListParams,
  Escalation,
  EventList,
  EventListParams,
  LoanDetail,
  LoanListParams,
  Loan,
  LoanSchedule,
  Payment,
  PaymentCreateParams,
  Portfolio,
  Product,
  WebhookEndpoint,
  WebhookEndpointCreateParams,
  WebhookEvent,
} from "../types"
import { toBlob, type Uploadable } from "./cases"

const enc = encodeURIComponent

export class PortfolioLoans {
  constructor(private readonly client: APIClient) {}

  list(params: LoanListParams & PageParams = {}, options?: RequestOptions): PagePromise<Loan> {
    return this.client.page("/v1/portfolio/loans", params as Record<string, unknown>, options)
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<LoanDetail> {
    return this.client.request({ method: "GET", path: `/v1/portfolio/loans/${enc(id)}` }, options)
  }

  schedule(id: string, options?: RequestOptions): APIPromise<LoanSchedule> {
    return this.client.request({ method: "GET", path: `/v1/portfolio/loans/${enc(id)}/schedule` }, options)
  }

  /** Record a payment. Idempotent: a retried call never records it twice. */
  recordPayment(id: string, params: PaymentCreateParams, options?: RequestOptions): APIPromise<Payment> {
    return this.client.request({ method: "POST", path: `/v1/portfolio/loans/${enc(id)}/payments`, body: params }, options)
  }
}

export class PortfolioResource {
  readonly loans: PortfolioLoans

  constructor(private readonly client: APIClient) {
    this.loans = new PortfolioLoans(client)
  }

  /** Totals across your funded loans. */
  summary(options?: RequestOptions): APIPromise<Portfolio> {
    return this.client.request({ method: "GET", path: "/v1/portfolio" }, options)
  }
}

export class Collections {
  constructor(private readonly client: APIClient) {}

  list(params: CollectionListParams & PageParams = {}, options?: RequestOptions): PagePromise<CollectionCase> {
    return this.client.page("/v1/collections", params as Record<string, unknown>, options)
  }

  logActivity(id: string, params: CollectionActivityParams, options?: RequestOptions): APIPromise<CollectionActivity> {
    return this.client.request({ method: "POST", path: `/v1/collections/${enc(id)}/activity`, body: params }, options)
  }

  escalate(id: string, params: CollectionEscalateParams, options?: RequestOptions): APIPromise<Escalation> {
    return this.client.request({ method: "POST", path: `/v1/collections/${enc(id)}/escalate`, body: params }, options)
  }
}

export class Products {
  constructor(private readonly client: APIClient) {}

  /** The product catalog and each product's application fields. */
  async list(options?: RequestOptions): Promise<Product[]> {
    const body = await this.client.request<{ data: Product[] } | Product[]>({ method: "GET", path: "/v1/products" }, options)
    return Array.isArray(body) ? body : body.data
  }
}

/** The brand on your applicant letters. */
export class BrandingResource {
  constructor(private readonly client: APIClient) {}

  retrieve(options?: RequestOptions): APIPromise<Branding> {
    return this.client.request({ method: "GET", path: "/v1/branding" }, options)
  }

  /** Send only the fields you change; `null` clears one. */
  update(params: BrandingUpdateParams, options?: RequestOptions): APIPromise<Branding> {
    return this.client.request({ method: "PUT", path: "/v1/branding", body: params }, options)
  }

  /** PNG, JPEG, WebP or SVG up to 5 MiB; a wide logo on a transparent background prints best. */
  uploadLogo(file: Uploadable, options?: RequestOptions): APIPromise<Branding> {
    const { blob, filename } = toBlob(file, "logo")
    const form = new FormData()
    form.append("file", blob, filename)
    return this.client.request({ method: "POST", path: "/v1/branding/logo", form }, options)
  }
}

/** Where we send webhooks. */
export class WebhookEndpoints {
  constructor(private readonly client: APIClient) {}

  /** Register an endpoint. The response carries its signing `secret` ONCE: store it. */
  create(params: WebhookEndpointCreateParams, options?: RequestOptions): APIPromise<WebhookEndpoint & { secret?: string }> {
    return this.client.request({ method: "POST", path: "/v1/webhooks", body: params }, options)
  }

  list(params: PageParams = {}, options?: RequestOptions): PagePromise<WebhookEndpoint> {
    return this.client.page("/v1/webhooks", params as Record<string, unknown>, options)
  }

  del(id: string, options?: RequestOptions): APIPromise<Record<string, unknown> | null> {
    return this.client.request({ method: "DELETE", path: `/v1/webhooks/${enc(id)}` }, options)
  }
}

export interface EventStreamOptions {
  /** Start after this event id. Default: only events from now on. */
  after?: string
  type?: EventListParams["type"]
  /** Poll interval (ms) while idle. Default 1500. */
  pollInterval?: number
  signal?: AbortSignal
}

/** The events your webhooks are sent: replay what you missed, or tail them. */
export class Events {
  constructor(private readonly client: APIClient) {}

  /** Without `after`: the most recent, newest first. With `after`: the next ones, oldest first. */
  list(params: EventListParams = {}, options?: RequestOptions): APIPromise<EventList> {
    const type = Array.isArray(params.type) ? params.type.join(",") : params.type
    return this.client.request({ method: "GET", path: "/v1/events", query: { after: params.after, type, limit: params.limit } }, options)
  }

  /**
   * Every new event, in order, as it happens, until `signal` aborts.
   *
   *   for await (const event of hlhunt.events.stream({ signal })) console.log(event.type)
   */
  async *stream(options: EventStreamOptions = {}): AsyncGenerator<WebhookEvent> {
    const pollInterval = options.pollInterval ?? 1_500
    let cursor = options.after
    if (!cursor) {
      const latest = await this.list({ limit: 1 }, { signal: options.signal })
      cursor = latest.data[0]?.id
    }
    for (;;) {
      if (options.signal?.aborted) return
      const page = cursor
        ? await this.list({ after: cursor, type: options.type, limit: 100 }, { signal: options.signal })
        : await this.list({ type: options.type, limit: 100 }, { signal: options.signal }).then((p) => ({ ...p, data: [...p.data].reverse() }))
      for (const event of page.data) {
        cursor = event.id
        yield event
      }
      if (!page.has_more) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollInterval)
          options.signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
      }
    }
  }
}
