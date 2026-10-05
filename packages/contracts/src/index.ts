// Schemas are the source of truth; generated types do not replace runtime validation.
export const CONTRACT_VERSION = 'v1' as const
export type { NormalizedProduct } from './generated/normalized-product'
export type { FieldEvidence } from './generated/field-evidence'
export type { ExtractionRequest } from './generated/extraction-request'
export type { ExtractionResult } from './generated/extraction-result'
export type { JobStatus } from './generated/job-status'
export type { ComparisonOutcome } from './generated/comparison-outcome'
