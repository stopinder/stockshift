// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

export interface ExtractionRequest {
  schema_version: 'v1'
  tenant_id: string
  file_id: string
  job_id: string
  object: ObjectReference
  sha256: string
  media_type: 'text/csv' | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | 'application/pdf'
  page_selection: number[]
  sheet_selection: string[]
  mapping_profile_id: string | null
  config: ObjectReference
}
export interface ObjectReference {
  bucket: string
  object_key: string
}
