// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

export interface NormalizedProduct {
  schema_version: 'v1'
  record_id: string
  source_file_id: string
  supplier_sku: string | null
  normalized_supplier_sku: string | null
  description: string | null
  manufacturer: string | null
  manufacturer_part_number: string | null
  gtin: string | null
  pack_quantity: string | null
  unit: string | null
  cost_price: string | null
  retail_price: string | null
  rrp: string | null
  currency: string | null
  price_basis: ('unit' | 'pack') | null
  tax_basis: ('net' | 'gross') | null
  availability: string | null
  validation_issues: Issue[]
  evidence_ids: string[]
}
export interface Issue {
  code: string
  field: string | null
  message: string
}
