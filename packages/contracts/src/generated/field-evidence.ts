// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

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
export interface ObjectReference {
  bucket: string
  object_key: string
}
/**
 * A provider/heuristic score, never implicitly a calibrated probability.
 */
export interface Score {
  value: number
  score_type: 'provider_reported' | 'layout_heuristic' | 'matching_heuristic'
}
