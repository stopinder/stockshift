import assert from 'node:assert/strict'
import test from 'node:test'
import handler from '../api/uploads'

async function request(method: string, body: unknown, authorization?: string) {
  const headers: Record<string,string|number|readonly string[]> = {}
  const response = { statusCode:0, setHeader(name:string,value:string|number|readonly string[]) { headers[name] = value },
    end(value:string) { this.output = value }, output:'' }
  const req = { method, headers: authorization ? { authorization } : {}, body }
  await handler(req as unknown as Parameters<typeof handler>[0], response as unknown as Parameters<typeof handler>[1])
  return { ...response, headers }
}
test('endpoint accepts only POST and sets no-store', async () => {
  const response = await request('GET', {})
  assert.equal(response.statusCode,405)
  assert.equal(response.headers.Allow,'POST')
  assert.equal(response.headers['Cache-Control'],'no-store')
})
test('endpoint missing Bearer authentication fails before config/network', async () => {
  const response = await request('POST',{action:'create'})
  assert.equal(response.statusCode,401)
})
test('endpoint rejects invalid JSON shapes/actions before config/network', async () => {
  for (const body of [null, [], 'raw', {action:'download',url:'https://example.test'}]) {
    const response = await request('POST',body,'Bearer synthetic-token')
    assert.equal(response.statusCode,400)
    assert.ok(!response.output.includes('synthetic-token'))
  }
})
