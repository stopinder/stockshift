// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

export interface ExtractionResult {
  schema_version: 'v1'
  tenant_id: string
  file_id: string
  job_id: string
  provider: VersionMetadata
  raw_artifact: ObjectReference
  completion: {
    state: 'complete' | 'incomplete'
    total_units: number | null
    completed_units: number
    pending_units: number[]
    failed_units: number[]
  }
  records: {
    record_id: string
    raw_cells: {
      column_name: string | null
      value: string | null
      evidence_id: string
    }[]
    semantic_candidates: {
      [k: string]: string | null
    }
  }[]
  evidence: FieldEvidence[]
  warnings: Issue[]
}
export interface VersionMetadata {
  provider: string
  sdk_version: string
  model_version: string | null
  config_hash: string
}
export interface ObjectReference {
  bucket: string
  object_key: string
}
export interface FieldEvidence {
  schema_version: 'v1'
  evidence_id: string
  record_id: string
  source_file_id: string
  field_name: string
  raw_text: string | null
  locator: (
    | {
        page: number
        [k: string]: unknown
      }
    | {
        row: number
        [k: string]: unknown
      }
    | {
        bounding_polygon: unknown[]
        [k: string]: unknown
      }
  ) & {
    page: number | null
    sheet: string | null
    row: number | null
    column: string | null
    table: string | null
    cell: string | null
    bounding_polygon: [[number, number], [number, number], [number, number], ...[number, number][]] | null
    coordinate_system: ('page_pixels' | 'page_points' | 'normalized') | null
  }
  artifact: ObjectReference | null
  extraction_score?: Score | null
}
/**
 * A provider/heuristic score, never implicitly a calibrated probability.
 */
export interface Score {
  value: number
  score_type: 'provider_reported' | 'layout_heuristic' | 'matching_heuristic'
}
export interface Issue {
  code: string
  field: string | null
  message: string
}
