/**
 * Public types. Most come straight from the API's OpenAPI document
 * (src/generated/openapi.ts, regenerated with `npm run generate`), so the SDK
 * and the API cannot drift. The few the document leaves unmodelled are
 * written here by hand and marked.
 */
import type { components, operations } from "./generated/openapi"

type Schemas = components["schemas"]
type JsonBody<Op extends keyof operations> = operations[Op] extends { requestBody?: { content: { "application/json": infer B } } } ? B : never
type Query<Op extends keyof operations> = operations[Op] extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never

// ─── Resources ──────────────────────────────────────────────────────────────

export type CaseSummary = Schemas["SerializedCaseSummary"]
export type AvailableAssessment = Schemas["AvailableAssessment"]
export type InformationRequest = Schemas["InformationRequest"]
export type DecisionDocument = Schemas["SerializedDecisionDocument"]
export type CaseFactsParams = JsonBody<"post_cases_by_id_facts">
export type DecisionFactsParams = JsonBody<"post_decisions_by_id_facts">
export type EvidenceAccepted = Schemas["SerializedEvidenceAccepted"]
export type WebsiteResearch = Schemas["WebsiteResearch"]
export type ProcessingEvidence = Schemas["ProcessingEvidence"]
export type CaseDetail = Schemas["SerializedCaseDetail"]
export type CaseDecision = Schemas["SerializedCaseDecision"]
export type CaseProgress = Schemas["SerializedCaseProgress"]
export type Document = Schemas["SerializedDocument"]
export type AnalysisJob = Schemas["SerializedAnalysisJob"]
export type UnderwriteSubmission = Schemas["SerializedUnderwriteSubmission"]
export type Batch = Schemas["SerializedBatch"]
export type BatchItem = Schemas["SerializedBatchItem"]
export type Applicant = Schemas["SerializedApplicant"]
export type SendLink = Schemas["SerializedSendLink"]
export type BankLink = Schemas["SerializedBankLink"]
export type BankLinkStatus = Schemas["SerializedBankLinkStatus"]
export type BankTransaction = Schemas["SerializedBankTransaction"]
export type Portfolio = Schemas["SerializedPortfolio"]
export type Loan = Schemas["SerializedLoan"]
export type LoanDetail = Schemas["SerializedLoanDetail"]
export type LoanSchedule = Schemas["SerializedLoanSchedule"]
export type Payment = Schemas["SerializedPayment"]
export type CollectionCase = Schemas["SerializedCollectionCase"]
export type CollectionActivity = Schemas["SerializedCollectionActivity"]
export type Escalation = Schemas["SerializedEscalation"]
export type Product = Schemas["SerializedProduct"]
export type WebhookEndpoint = Schemas["SerializedWebhookSubscription"]
export type DecisionLetter = Schemas["SerializedDecisionLetter"]
export type Decision = Schemas["SerializedDecisionRequest"]

// ─── Request bodies and query parameters ────────────────────────────────────

export type UnderwriteParams = JsonBody<"post_underwrite">
export type UnderwriteBatchParams = JsonBody<"post_underwrite_batch">
export type CaseDecideParams = JsonBody<"post_cases_by_id_decision">
export type CaseListParams = Query<"get_cases">
export type DecisionCreateParams = JsonBody<"post_decisions">
export type DecisionOutcomeParams = JsonBody<"post_decisions_by_id_outcome">
export type DecisionListParams = Query<"get_decisions">
export type DecisionPolicyUpdateParams = JsonBody<"put_decision_policies">
export type BrandingUpdateParams = JsonBody<"put_branding">
export type ApplicantUpdateParams = JsonBody<"patch_applicants_by_id">
export type ApplicantListParams = Query<"get_applicants">
export type BankLinkCreateParams = JsonBody<"post_bank_link">
export type PaymentCreateParams = JsonBody<"post_portfolio_loans_by_id_payments">
export type LoanListParams = Query<"get_portfolio_loans">
export type CollectionListParams = Query<"get_collections">
export type CollectionActivityParams = JsonBody<"post_collections_by_id_activity">
export type CollectionEscalateParams = JsonBody<"post_collections_by_id_escalate">
export type DocumentVerifyParams = JsonBody<"patch_documents_by_id_verify">
export type WebhookEndpointCreateParams = JsonBody<"post_webhooks">
export type ProductListParams = Query<"get_products">

// ─── Hand-written: shapes the OpenAPI document leaves unmodelled ────────────

/** `GET /v1/branding`, `PUT /v1/branding`, `POST /v1/branding/logo`. */
export interface Branding {
  brand_name: string
  logo_set: boolean
  accent_color: string | null
  address: string | null
  phone: string | null
  website: string | null
  support_email: string | null
  creditor_legal_name: string | null
  creditor_address: string | null
  regulator_name: string | null
  regulator_address: string | null
  signatory: string | null
  sender_name: string | null
  reply_to: string | null
  letter_delivery: "email" | "generate_only"
}

/** One credit policy the Decision Agent applies. */
export interface DecisionPolicy {
  id: string | null
  product: string
  decision_type: "new_credit" | "limit_change" | "account_review"
  version: number
  /** True for the built-in default, shown until you save your own. */
  is_default: boolean
  rules: DecisionPolicyUpdateParams["rules"]
  created_at: string | null
}

export type WebhookEventType =
  | "application.information_requested"
  | "application.evidence_received"
  | "application.analysis_resumed"
  | "application.analysis_completed"
  | "decision.evidence_required"
  | "decision.evidence_received"
  | "decision.analysis_resumed"
  | "account.early_warning"
  | "application.received"
  | "application.decided"
  | "application.needs_review"
  | "application.analysis_failed"
  | "batch.completed"
  | "document.analyzed"
  | "bank_link.connected"
  | "letter.issued"
  | "decision.completed"

/** `letter.issued`'s payload. */
export interface LetterIssued {
  id: string
  case_id: string | null
  decision_id: string | null
  kind: "adverse_action_decline" | "adverse_action_counter"
  status: "emailed" | "email_failed" | "generated"
  reasons: Array<{ code: string; text: string; detail: string | null }>
  created_at: string
  pdf_path: string
}

/** What each event carries in `data`. */
export interface CaseAnalysisEvent {
  case_id: string
  application_id: string
  business_id: string | null
  mode: "test" | "live"
  occurred_at: string
  updated_at: string
  analysis_id?: string
  assessment?: AvailableAssessment
  information_requests?: InformationRequest[]
  document_id?: string
  fact_keys?: string[]
}
export interface WebhookEventData {
  "application.information_requested": CaseAnalysisEvent
  "application.evidence_received": CaseAnalysisEvent
  "application.analysis_resumed": CaseAnalysisEvent
  "application.analysis_completed": CaseAnalysisEvent
  "decision.evidence_required": Decision
  "decision.evidence_received": Decision
  "decision.analysis_resumed": Decision
  "account.early_warning": Record<string, unknown>
  "application.received": CaseSummary
  "application.decided": CaseDecision
  "application.needs_review": CaseDecision
  "application.analysis_failed": Record<string, unknown>
  "batch.completed": Batch
  "document.analyzed": Document
  "bank_link.connected": BankLinkStatus
  "letter.issued": LetterIssued
  "decision.completed": Decision
}

/** A webhook (or `GET /v1/events`) event. Narrow on `type` and `data` is typed. */
export type WebhookEvent = {
  [K in WebhookEventType]: {
    /** The same on every retry: de-duplicate on it. */
    id: string
    type: K
    livemode: boolean
    environment: "live" | "test"
    created_at: string
    data: WebhookEventData[K]
  }
}[WebhookEventType]

export interface EventListParams {
  /** Only these types. */
  type?: WebhookEventType | WebhookEventType[]
  /** Events after this event id, oldest first. Without it: the most recent, newest first. */
  after?: string
  /** 1 to 100, default 50. */
  limit?: number
}

export interface EventList {
  data: WebhookEvent[]
  has_more: boolean
}
