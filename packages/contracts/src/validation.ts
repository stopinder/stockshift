import Ajv, { type ErrorObject } from 'ajv'
import addFormats from 'ajv-formats'
import common from '../schemas/v1/common.schema.json'
import product from '../schemas/v1/normalized-product.schema.json'
import evidence from '../schemas/v1/field-evidence.schema.json'
import request from '../schemas/v1/extraction-request.schema.json'
import result from '../schemas/v1/extraction-result.schema.json'
import job from '../schemas/v1/job-status.schema.json'
import outcome from '../schemas/v1/comparison-outcome.schema.json'
import type { NormalizedProduct, FieldEvidence, ExtractionRequest, ExtractionResult, JobStatus, ComparisonOutcome } from './index'

export interface ContractMap {
  'normalized-product': NormalizedProduct
  'field-evidence': FieldEvidence
  'extraction-request': ExtractionRequest
  'extraction-result': ExtractionResult
  'job-status': JobStatus
  'comparison-outcome': ComparisonOutcome
}
export type ContractName = keyof ContractMap

const schemas = {
  'normalized-product': product,
  'field-evidence': evidence,
  'extraction-request': request,
  'extraction-result': result,
  'job-status': job,
  'comparison-outcome': outcome,
}
const ajv = new Ajv({ allErrors: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
addFormats(ajv)
ajv.addSchema(common)
for (const schema of Object.values(schemas)) ajv.addSchema(schema)

export class ContractValidationError extends Error {
  constructor(readonly contract: ContractName, readonly issues: readonly ErrorObject[]) {
    super(`Invalid ${contract} contract`)
    this.name = 'ContractValidationError'
  }
}

/** Validate without coercion, defaults, data mutation, or remote schema fetching. */
export function validateContract<N extends ContractName>(name: N, value: unknown): ContractMap[N] {
  const validate = ajv.getSchema(schemas[name].$id)!
  if (!validate(value)) {
    throw new ContractValidationError(name, structuredClone(validate.errors ?? []))
  }
  // Draft 7 cannot compare sibling property values; keep these guards in parity with Python.
  const counters = name === 'extraction-result'
    ? (value as ExtractionResult).completion
    : name === 'job-status' ? value as JobStatus : null
  if (counters !== null && counters.total_units !== null) {
    const exceedsTotal = counters.completed_units > counters.total_units
    const incompleteClaim = name === 'extraction-result'
      && (value as ExtractionResult).completion.state === 'complete'
      && counters.completed_units !== counters.total_units
    if (exceedsTotal || incompleteClaim) {
      throw new ContractValidationError(name, [{
        instancePath: name === 'extraction-result' ? '/completion' : '',
        schemaPath: '#/count-consistency',
        keyword: 'count-consistency',
        params: {},
        message: 'completed units must not exceed total; complete extraction must equal total',
      }])
    }
  }
  return value as ContractMap[N]
}
