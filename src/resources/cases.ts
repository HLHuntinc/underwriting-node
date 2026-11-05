import { pollUntil, type APIClient, type APIPromise, type BinaryFile, type PagePromise, type PageParams, type RequestOptions, type WaitOptions } from "../core"
import { HLHuntError, WaitTimeoutError } from "../errors"
import type {
  Applicant,
  ApplicantListParams,
  ApplicantUpdateParams,
  BankLink,
  BankLinkCreateParams,
  BankLinkStatus,
  BankTransaction,
  Batch,
  CaseDecideParams,
  CaseDecision,
  CaseDetail,
  CaseListParams,
  CaseSummary,
  DecisionLetter,
  Document,
  DocumentVerifyParams,
  SendLink,
  UnderwriteBatchParams,
  UnderwriteParams,
  UnderwriteSubmission,
} from "../types"

const enc = encodeURIComponent

/** A file to upload: a Blob/File, or raw bytes with a filename. */
export type Uploadable =
  | Blob
  | { data: Uint8Array | ArrayBuffer; filename: string; contentType?: string }

export interface DocumentUploadParams {
  file: Uploadable
  /** e.g. `bank_statement`. */
  category?: string
  name?: string
  description?: string
  /** Group the pages (photos) of ONE statement so they are read as one statement. */
  statement_id?: string
}

/** A Blob and filename for multipart, from any Uploadable. Bytes are copied, so a later change to your buffer cannot alter the upload. */
export function toBlob(file: Uploadable, fallbackName = "upload"): { blob: Blob; filename: string } {
  if (file instanceof Blob) return { blob: file, filename: (file as File).name || fallbackName }
  if (!file || !("data" in file) || !file.filename) throw new HLHuntError("file must be a Blob/File or { data, filename }.")
  const bytes = new Uint8Array(file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data))
  return { blob: new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }), filename: file.filename }
}

/** Submit applications for underwriting. */
export class Underwrite {
  constructor(private readonly client: APIClient, private readonly cases: Cases) {}

  /** Submit one application. Analysis runs in the background; see `createAndWait` or the `application.decided` webhook. */
  create(params: UnderwriteParams, options?: RequestOptions): APIPromise<UnderwriteSubmission> {
    return this.client.request({ method: "POST", path: "/v1/underwrite", body: params }, options)
  }

  /** Submit and wait until analysis has finished (or needs you: documents, a retry, a decision). Returns the case. */
  async createAndWait(params: UnderwriteParams, options: WaitOptions & RequestOptions = {}): Promise<CaseDetail> {
    const submission = await this.create(params, options)
    return this.cases.waitForAnalysis(submission.id, options)
  }

  /** Submit up to the batch limit at once. */
  createBatch(params: UnderwriteBatchParams, options?: RequestOptions): APIPromise<Batch> {
    return this.client.request({ method: "POST", path: "/v1/underwrite/batch", body: params }, options)
  }

  retrieveBatch(id: string, options?: RequestOptions): APIPromise<Batch> {
    return this.client.request({ method: "GET", path: `/v1/underwrite/batch/${enc(id)}` }, options)
  }

  /** Wait until every item in a batch has finished. */
  async waitForBatch(id: string, options: WaitOptions & RequestOptions = {}): Promise<Batch> {
    return pollUntil(
      () => this.retrieveBatch(id, options),
      (b) => b.status === "completed",
      options,
      (last) => new WaitTimeoutError(`Batch ${id} was still ${last.status} after waiting.`, last),
    )
  }
}

export class CaseDocuments {
  constructor(private readonly client: APIClient) {}

  list(caseId: string, params: PageParams = {}, options?: RequestOptions): PagePromise<Document> {
    return this.client.page(`/v1/cases/${enc(caseId)}/documents`, params as Record<string, unknown>, options)
  }

  /** Upload a statement or other document (PDF, JPEG, PNG, HEIC...). Analysis starts automatically. */
  upload(caseId: string, params: DocumentUploadParams, options?: RequestOptions): APIPromise<Document> {
    const { blob, filename } = toBlob(params.file)
    const form = new FormData()
    form.append("file", blob, filename)
    for (const key of ["category", "name", "description", "statement_id"] as const) {
      const value = params[key]
      if (value !== undefined && value !== null) form.append(key, String(value))
    }
    return this.client.request({ method: "POST", path: `/v1/cases/${enc(caseId)}/documents`, form }, options)
  }

  /** Record a person's verification of a document. */
  verify(documentId: string, params: DocumentVerifyParams, options?: RequestOptions): APIPromise<Document> {
    return this.client.request({ method: "PATCH", path: `/v1/documents/${enc(documentId)}/verify`, body: params }, options)
  }
}

export class Cases {
  readonly documents: CaseDocuments

  constructor(private readonly client: APIClient) {
    this.documents = new CaseDocuments(client)
  }

  list(params: CaseListParams & PageParams = {}, options?: RequestOptions): PagePromise<CaseSummary> {
    return this.client.page("/v1/cases", params as Record<string, unknown>, options)
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<CaseDetail> {
    return this.client.request({ method: "GET", path: `/v1/cases/${enc(id)}` }, options)
  }

  /** Record a binding decision (approve, decline) or route to review. Needs the `cases:decide` scope. */
  decide(id: string, params: CaseDecideParams, options?: RequestOptions): APIPromise<CaseDecision> {
    return this.client.request({ method: "POST", path: `/v1/cases/${enc(id)}/decision`, body: params }, options)
  }

  /** Run the analysis again (after new documents). */
  reanalyze(id: string, options?: RequestOptions): APIPromise<Record<string, unknown>> {
    return this.client.request({ method: "POST", path: `/v1/cases/${enc(id)}/reanalyze` }, options)
  }

  /** The underwriting report as a PDF. */
  reportPdf(id: string, options?: RequestOptions): APIPromise<BinaryFile> {
    return this.client.request({ method: "GET", path: `/v1/cases/${enc(id)}/report/pdf`, responseType: "binary" }, options)
  }

  /** Adverse-action letters issued for this case, newest first. */
  async letters(id: string, options?: RequestOptions): Promise<DecisionLetter[]> {
    const body = await this.client.request<{ data: DecisionLetter[] }>({ method: "GET", path: `/v1/cases/${enc(id)}/letters` }, options)
    return body.data
  }

  /** Wait until HL Hunt has finished working on a case (`processing.next_step` is no longer `wait`). */
  async waitForAnalysis(id: string, options: WaitOptions & RequestOptions = {}): Promise<CaseDetail> {
    return pollUntil(
      () => this.retrieve(id, options),
      (c) => c.processing?.next_step !== "wait",
      options,
      (last) => new WaitTimeoutError(`Case ${id} was still being analysed (${last.processing?.stage ?? "unknown"}) after waiting.`, last),
    )
  }
}

export class Letters {
  constructor(private readonly client: APIClient) {}

  /** Download a letter's PDF. */
  pdf(id: string, options?: RequestOptions): APIPromise<BinaryFile> {
    return this.client.request({ method: "GET", path: `/v1/letters/${enc(id)}/pdf`, responseType: "binary" }, options)
  }
}

export class Applicants {
  constructor(private readonly client: APIClient) {}

  list(params: ApplicantListParams & PageParams = {}, options?: RequestOptions): PagePromise<Applicant> {
    return this.client.page("/v1/applicants", params as Record<string, unknown>, options)
  }

  retrieve(id: string, options?: RequestOptions): APIPromise<Applicant> {
    return this.client.request({ method: "GET", path: `/v1/applicants/${enc(id)}` }, options)
  }

  update(id: string, params: ApplicantUpdateParams, options?: RequestOptions): APIPromise<Applicant> {
    return this.client.request({ method: "PATCH", path: `/v1/applicants/${enc(id)}`, body: params }, options)
  }

  /** Email the applicant a link (application or bank connection). In live mode this contacts the applicant. */
  sendLink(id: string, params: { link_type?: string; product_slug?: string }, options?: RequestOptions): APIPromise<SendLink> {
    return this.client.request({ method: "POST", path: `/v1/applicants/${enc(id)}/send-link`, body: params }, options)
  }
}

export class BankLinks {
  constructor(private readonly client: APIClient) {}

  /** Mint a bank-connection link for a case. In live mode this emails the applicant. */
  create(params: BankLinkCreateParams, options?: RequestOptions): APIPromise<BankLink> {
    return this.client.request({ method: "POST", path: "/v1/bank-link", body: params }, options)
  }

  status(id: string, options?: RequestOptions): APIPromise<BankLinkStatus> {
    return this.client.request({ method: "GET", path: `/v1/bank-link/${enc(id)}/status` }, options)
  }

  transactions(
    id: string,
    params: PageParams & { date_from?: string; date_to?: string; min_amount?: number; type?: string } = {},
    options?: RequestOptions,
  ): PagePromise<BankTransaction> {
    return this.client.page(`/v1/bank-link/${enc(id)}/transactions`, params as Record<string, unknown>, options)
  }
}
