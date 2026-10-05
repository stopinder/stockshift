import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createUploadIntent, finalizeUpload, MAX_UPLOAD_BYTES, parseIntent, UploadError, verifyCsv,
  type Intent, type Role, type SourceFile, type UploadGateway } from '../server/uploads'
import { SupabaseUploadGateway, validateLocalConfig } from '../server/supabase-upload-gateway'

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const actor = '11111111-1111-4111-8111-111111111111'
const fileId = '55555555-5555-4555-8555-555555555555'
const input = { tenantId: tenant, filename: 'catalogue.csv', byteCount: 14 }
const bytes = new TextEncoder().encode('sku,price\n1,2\n')
const record: SourceFile = { id: fileId, tenant_id: tenant, created_by: actor,
  original_filename: input.filename, bucket_id: 'catalogue-uploads', object_name: `${tenant}/${fileId}/original`,
  expected_byte_count: bytes.length, status: 'pending', byte_count: null, verified_mime: null, sha256: null }

class FakeGateway implements UploadGateway {
  calls: string[] = []
  role: Role | null = 'editor'
  file: SourceFile = { ...record }
  blob = new Blob([bytes])
  failFinish = false
  async authenticate(token: string) { this.calls.push('authenticate'); if (token !== 'valid') throw new UploadError(401, 'Invalid'); return actor }
  async membership() { this.calls.push('membership'); return this.role }
  async createIntent(_input: Intent, _token: string) { this.calls.push('create'); return this.file }
  async signUpload() { this.calls.push('sign'); return { signedUrl: 'http://127.0.0.1:54321/signed', token: 'upload-token' } }
  async transition(_tenant: string, _file: string, _actor: string, action: 'begin'|'finish'|'fail',
    verified?: { bytes: number; mime: string; sha256: string }) {
    this.calls.push(action)
    if (action === 'begin' && this.file.status === 'pending') this.file = { ...this.file, status: 'verifying' }
    if (action === 'fail') this.file = { ...this.file, status: 'failed' }
    if (action === 'finish') {
      if (this.failFinish) throw new UploadError(409, 'Database failure')
      this.file = { ...this.file, status: 'ready', byte_count: verified!.bytes,
        verified_mime: verified!.mime, sha256: verified!.sha256 }
    }
    return this.file
  }
  async download() { this.calls.push('download'); return this.blob }
}

test('intent authenticates, checks current membership, registers then signs private path', async () => {
  const gateway = new FakeGateway()
  const output = await createUploadIntent(gateway, 'valid', input)
  assert.deepEqual(gateway.calls, ['authenticate','membership','create','sign'])
  assert.equal(output.path, record.object_name)
  assert.equal(output.bucket, 'catalogue-uploads')
})
for (const role of ['viewer', null] as const) {
  test(`role ${role} cannot upload or finalize`, async () => {
    const gateway = new FakeGateway(); gateway.role = role
    await assert.rejects(createUploadIntent(gateway,'valid',input), { status:403 })
    await assert.rejects(finalizeUpload(gateway,'valid',{tenantId:tenant,fileId}), { status:403 })
    assert.ok(!gateway.calls.includes('create') && !gateway.calls.includes('begin'))
  })
}
test('invalid auth cannot reach privileged operations', async () => {
  const gateway = new FakeGateway()
  await assert.rejects(createUploadIntent(gateway,'expired',input), { status:401 })
  assert.deepEqual(gateway.calls,['authenticate'])
})
for (const filename of ['../file.csv', 'folder\\file.csv', 'https://example.test/file.csv', 'file.pdf', 'file.csv\u0000']) {
  test(`reject unsafe/unsupported filename ${JSON.stringify(filename)}`, () => {
    assert.throws(() => parseIntent({...input,filename}), { status:400 })
  })
}
for (const byteCount of [0, -1, MAX_UPLOAD_BYTES + 1, 1.5, NaN]) {
  test(`reject invalid size ${byteCount}`, () => { assert.throws(() => parseIntent({...input,byteCount}), { status:400 }) })
}
test('request cannot supply object path, external URL, creator or verified metadata', () => {
  for (const key of ['objectPath','url','created_by','sha256','verified_mime']) {
    assert.throws(() => parseIntent({...input,[key]:'forged'}), { status:400 })
  }
})
test('forged database tenant/creator/path is never signed', async () => {
  for (const override of [{tenant_id:fileId}, {created_by:fileId}, {object_name:'external/path'}]) {
    const gateway = new FakeGateway(); gateway.file = {...record,...override}
    await assert.rejects(createUploadIntent(gateway,'valid',input), { status:403 })
    assert.ok(!gateway.calls.includes('sign'))
  }
})
test('finalization computes actual byte count, content MIME and SHA-256', async () => {
  const gateway = new FakeGateway()
  const ready = await finalizeUpload(gateway,'valid',{tenantId:tenant,fileId})
  assert.equal(ready.status,'ready')
  assert.equal(ready.byteCount,bytes.length)
  assert.equal(ready.mime,'text/csv')
  assert.equal(ready.sha256,createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(gateway.calls,['authenticate','membership','begin','download','finish'])
})
test('idempotent ready finalize does not re-download or change object', async () => {
  const gateway = new FakeGateway()
  await finalizeUpload(gateway,'valid',{tenantId:tenant,fileId})
  gateway.calls = []
  const ready = await finalizeUpload(gateway,'valid',{tenantId:tenant,fileId})
  assert.equal(ready.status,'ready')
  assert.deepEqual(gateway.calls,['authenticate','membership','begin'])
})
test('claimed content type cannot override binary/unsupported bytes', async () => {
  const gateway = new FakeGateway()
  gateway.blob = new Blob([new Uint8Array(bytes.length)], {type:'text/csv'})
  await assert.rejects(finalizeUpload(gateway,'valid',{tenantId:tenant,fileId}), { status:422 })
  assert.equal(gateway.file.status,'failed')
  assert.ok(!gateway.calls.includes('finish'))
})
test('mismatched actual size never marks ready', async () => {
  const gateway = new FakeGateway(); gateway.blob = new Blob(['short'])
  await assert.rejects(finalizeUpload(gateway,'valid',{tenantId:tenant,fileId}), { status:422 })
  assert.equal(gateway.file.status,'failed')
})
test('database finalization failure stays non-ready', async () => {
  const gateway = new FakeGateway(); gateway.failFinish = true
  await assert.rejects(finalizeUpload(gateway,'valid',{tenantId:tenant,fileId}), { status:409 })
  assert.equal(gateway.file.status,'failed')
})
test('finalization cannot choose external path or hash', async () => {
  const gateway = new FakeGateway()
  await assert.rejects(finalizeUpload(gateway,'valid',{tenantId:tenant,fileId,sha256:'forged'}), { status:400 })
  assert.deepEqual(gateway.calls,[])
})
for (const value of ['', '%PDF-1.7\n', 'PK\x03\x04', 'a\u0000b']) {
  test(`MIME gate rejects ${JSON.stringify(value)}`, () => {
    assert.throws(() => verifyCsv(new TextEncoder().encode(value)), { status:422 })
  })
}
test('CSV gate accepts UTF-8 BOM and hashes original bytes', () => {
  const data = new TextEncoder().encode('\ufeffsku,price\n001,2\n')
  assert.equal(verifyCsv(data).sha256,createHash('sha256').update(data).digest('hex'))
})
test('configuration rejects hosted and non-loopback API URLs', () => {
  const keys = { publishableKey:'synthetic-public-key',secretKey:'synthetic-server-key' }
  for (const url of ['https://example.supabase.co','http://example.test:54321',
    'http://127.0.0.1:54322','http://user:pass@localhost:54321','http://localhost:54321/other']) {
    assert.throws(() => validateLocalConfig({url,...keys}))
  }
  assert.equal(validateLocalConfig({url:'http://127.0.0.1:54321',...keys}).url,'http://127.0.0.1:54321')
})
test('SDK adapter validates user through Auth; upload signing uses user token with upsert false', async () => {
  const original = globalThis.fetch
  const requests: { url:string; authorization:string|null; upsert:string|null }[] = []
  globalThis.fetch = async (resource, options) => {
    const url = String(resource), headers = new Headers(options?.headers)
    requests.push({url,authorization:headers.get('Authorization'),upsert:headers.get('x-upsert')})
    assert.ok(url.startsWith('http://127.0.0.1:54321/'))
    if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({id:actor,is_anonymous:false}), {headers:{'Content-Type':'application/json'}})
    if (url.includes('/rest/v1/tenant_memberships')) return new Response(JSON.stringify({role:'editor'}), {headers:{'Content-Type':'application/json'}})
    if (url.includes('/rpc/create_upload_intent')) return new Response(JSON.stringify(record), {headers:{'Content-Type':'application/json'}})
    if (url.includes('/storage/v1/object/upload/sign/')) return new Response(JSON.stringify({url:`/object/upload/sign/catalogue-uploads/${record.object_name}?token=signed-token`}), {headers:{'Content-Type':'application/json'}})
    throw new Error('Unexpected SDK request')
  }
  try {
    const gateway = new SupabaseUploadGateway({url:'http://127.0.0.1:54321',publishableKey:'test-public',secretKey:'test-secret'})
    const output = await createUploadIntent(gateway,'valid',input)
    assert.equal(output.path,record.object_name)
    assert.equal(requests[0]!.authorization,'Bearer valid')
    assert.equal(requests[1]!.authorization,'Bearer test-secret')
    assert.equal(requests[2]!.authorization,'Bearer valid')
    assert.equal(requests[3]!.authorization,'Bearer valid')
    assert.notEqual(requests[3]!.upsert,'true')
  } finally { globalThis.fetch = original }
})
