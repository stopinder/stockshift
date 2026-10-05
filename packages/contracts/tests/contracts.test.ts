import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ContractValidationError, validateContract, type ContractName } from '../src/validation'
import { CONTRACT_VERSION } from '../src/index'

interface Fixture {
  name: string
  contract: ContractName
  valid: boolean
  payload: unknown
}
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL('../../../tests/fixtures/contracts/cases.json', import.meta.url), 'utf8'))

test('fixture corpus covers every contract and version', () => {
  assert.equal(CONTRACT_VERSION, 'v1')
  for (const name of ['normalized-product', 'field-evidence', 'extraction-request', 'extraction-result', 'job-status', 'comparison-outcome']) {
    assert.ok(fixtures.some(item => item.contract === name && item.valid))
    assert.ok(fixtures.some(item => item.contract === name && !item.valid))
  }
})

for (const fixture of fixtures) {
  test(fixture.name, () => {
    const original = structuredClone(fixture.payload)
    if (fixture.valid) {
      assert.equal(validateContract(fixture.contract, fixture.payload), fixture.payload)
    } else {
      assert.throws(() => validateContract(fixture.contract, fixture.payload), ContractValidationError)
    }
    assert.deepEqual(fixture.payload, original, 'validation must never mutate the input')
  })
}

test('normalized decimal scale and source identifiers survive JSON round-trip', () => {
  const fixture = fixtures.find(item => item.name === 'normalized-product: valid v1')!
  const product = validateContract('normalized-product', JSON.parse(JSON.stringify(fixture.payload)))
  assert.equal(product.cost_price, '6.4000')
  assert.equal(product.supplier_sku, '001821')
  assert.equal(product.retail_price, null)
  assert.equal(product.manufacturer_part_number, '00017')
})

test('validation does not invent confidence', () => {
  const fixture = fixtures.find(item => item.name === 'confidence: absent stays absent')!
  const evidence = validateContract('field-evidence', fixture.payload)
  assert.equal(Object.hasOwn(evidence, 'extraction_score'), false)
})
