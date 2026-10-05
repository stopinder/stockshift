// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

export type ComparisonOutcome = (
  | {
      old_record_id: string
      [k: string]: unknown
    }
  | {
      new_record_id: string
      [k: string]: unknown
    }
) & {
  schema_version: 'v1'
  result_id: string
  old_record_id: string | null
  new_record_id: string | null
  outcome: 'unchanged' | 'changed' | 'new' | 'absent' | 'needs_review'
  review_state: 'not_required' | 'pending' | 'approved' | 'rejected'
  change_flags: (
    | 'price_increase'
    | 'price_decrease'
    | 'description'
    | 'supplier_sku'
    | 'manufacturer_part_number'
    | 'pack_quantity'
    | 'unit'
    | 'retail_price'
    | 'rrp'
    | 'availability'
  )[]
  cost_delta: string | null
  cost_change_percent: string | null
  old_margin_percent: string | null
  new_margin_percent: string | null
  margin_point_delta: string | null
  calculation_issues: Issue[]
  matching_score?: Score | null
}

export interface Issue {
  code: string
  field: string | null
  message: string
}
/**
 * A provider/heuristic score, never implicitly a calibrated probability.
 */
export interface Score {
  value: number
  score_type: 'provider_reported' | 'layout_heuristic' | 'matching_heuristic'
}
