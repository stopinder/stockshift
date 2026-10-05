// Generated from schemas/v1. Run npm run contracts:generate; do not edit.

export type JobStatus = {
  schema_version: 'v1'
  job_id: string
  state: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled'
  stage: string | null
  completed_units: number
  total_units: number | null
  failure_code: string | null
}
