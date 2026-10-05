// Explicit local integration runner; never reads hosted credentials or URLs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { before, after, test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { SupabaseUploadGateway } from '../../apps/web/server/supabase-upload-gateway'
import { createUploadIntent, finalizeUpload } from '../../apps/web/server/uploads'

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_)/i.test(key)))
const status = JSON.parse(execFileSync(process.execPath,
  ['scripts/supabase-local.mjs', 'status', '--output', 'json'], { env, encoding: 'utf8' }))
const url = 'http://127.0.0.1:54321'
assert.equal(status.API_URL, url)
const config = { url, publishableKey: status.ANON_KEY, secretKey: status.SERVICE_ROLE_KEY }
assert.ok(config.publishableKey && config.secretKey, 'Local stack keys required')
const admin = createClient(url, config.secretKey, { auth: { persistSession: false } })
const db = new Client({ host: '127.0.0.1', port: 54322, database: 'postgres',
  user: 'postgres', password: 'postgres', ssl: false })
const gateway = new SupabaseUploadGateway(config)
const A = randomUUID(), B = randomUUID()
const users: Record<string, { id: string; token: string; client: ReturnType<typeof createClient> }> = {}
const bytes = Buffer.from('sku,price\n001,2.50\n')
const bucket = 'catalogue-uploads'

before(async () => {
  await db.connect()
  for (const role of ['owner', 'editor', 'viewer', 'other']) {
    const email = `${randomUUID()}@stockshift.local`, password = randomUUID()
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.ifError(created.error)
    const client = createClient(url, config.publishableKey, { auth: { persistSession: false } })
    const login = await client.auth.signInWithPassword({ email, password })
    assert.ifError(login.error)
    users[role] = { id: created.data.user!.id, token: login.data.session!.access_token, client }
  }
  await db.query('insert into public.tenants(id,name) values ($1,$2),($3,$4)', [A,'HTTP tenant A',B,'HTTP tenant B'])
  for (const role of ['owner', 'editor', 'viewer', 'other']) {
    await db.query('insert into public.tenant_memberships(tenant_id,user_id,role) values ($1,$2,$3)',
      [role === 'other' ? B : A, users[role]!.id, role === 'other' ? 'owner' : role])
  }
})
after(async () => { await db.end() })

async function intent() {
  return createUploadIntent(gateway, users.editor!.token,
    { tenantId: A, filename: 'catalogue.csv', byteCount: bytes.length })
}
async function uploaded() {
  const file = await intent()
  const result = await users.editor!.client.storage.from(bucket)
    .uploadToSignedUrl(file.path, file.token, bytes, { contentType: 'text/csv' })
  assert.ifError(result.error)
  return file
}

test('real bucket is private with a 10 MiB limit and CSV MIME allowlist', async () => {
  const { data, error } = await admin.storage.getBucket(bucket)
  assert.ifError(error)
  assert.equal(data!.public, false)
  assert.equal(Number(data!.file_size_limit), 10485760)
  assert.deepEqual(data!.allowed_mime_types, ['text/csv','application/octet-stream','application/vnd.ms-excel'])
})
test('real Auth and signed upload finalize with verified bytes, MIME, SHA and idempotency', async () => {
  const file = await uploaded()
  const ready = await finalizeUpload(gateway, users.editor!.token, { tenantId: A, fileId: file.fileId })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.byteCount, bytes.length)
  assert.equal(ready.mime, 'text/csv')
  assert.equal(ready.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.deepEqual(await finalizeUpload(gateway, users.editor!.token,
    { tenantId: A, fileId: file.fileId }), ready)
})
test('viewer can download own-tenant bytes; other tenant cannot read or list them', async () => {
  const file = await uploaded()
  const read = await users.viewer!.client.storage.from(bucket).download(file.path)
  assert.ifError(read.error)
  assert.deepEqual(Buffer.from(await read.data!.arrayBuffer()), bytes)
  assert.ok((await users.other!.client.storage.from(bucket).download(file.path)).error)
  const list = await users.other!.client.storage.from(bucket).list(`${A}/${file.fileId}`)
  assert.ifError(list.error)
  assert.equal(list.data!.length, 0)
  const publicRead = await fetch(`${url}/storage/v1/object/public/${bucket}/${file.path}`)
  assert.ok(!publicRead.ok)
})
test('viewer and another tenant cannot create upload intents or finalize', async () => {
  const file = await uploaded()
  for (const role of ['viewer','other']) {
    await assert.rejects(createUploadIntent(gateway, users[role]!.token,
      { tenantId: A, filename: 'file.csv', byteCount: bytes.length }), { status: 403 })
    await assert.rejects(finalizeUpload(gateway, users[role]!.token,
      { tenantId: A, fileId: file.fileId }), { status: 403 })
  }
})
test('registered pending path accepts creator upload and rejects viewer, cross-tenant and arbitrary paths', async () => {
  const file = await intent()
  for (const role of ['viewer','other','owner']) {
    assert.ok((await users[role]!.client.storage.from(bucket).upload(file.path, bytes,
      { contentType: 'text/csv' })).error)
  }
  for (const path of [`${B}/${file.fileId}/original`, `${A}/${file.fileId}/arbitrary.csv`]) {
    assert.ok((await users.editor!.client.storage.from(bucket).upload(path, bytes,
      { contentType: 'text/csv' })).error)
  }
  assert.ifError((await users.editor!.client.storage.from(bucket).upload(file.path, bytes,
    { contentType: 'text/csv' })).error)
})
test('finalized object rejects replacement, move and delete through Storage HTTP', async () => {
  const file = await uploaded()
  await finalizeUpload(gateway, users.editor!.token, { tenantId: A, fileId: file.fileId })
  const storage = users.editor!.client.storage.from(bucket)
  assert.ok((await storage.upload(file.path, bytes, { contentType: 'text/csv', upsert: true })).error)
  assert.ok((await storage.move(file.path, `${B}/${file.fileId}/original`)).error)
  // DELETE can return an empty success for invisible rows; verify bytes survive.
  await storage.remove([file.path])
  const read = await storage.download(file.path)
  assert.ifError(read.error)
  assert.deepEqual(Buffer.from(await read.data!.arrayBuffer()), bytes)
  assert.ok((await admin.storage.from(bucket).remove([file.path])).error)
})
test('missing blob cannot finalize; pending source cannot attach to a comparison', async () => {
  const file = await intent()
  await assert.rejects(finalizeUpload(gateway, users.editor!.token,
    { tenantId: A, fileId: file.fileId }), { status: 409 })
  const comp = await users.editor!.client.from('comparisons').insert({ tenant_id: A, title: 'Pending' }).select().single()
  assert.ifError(comp.error)
  const attached = await users.editor!.client.from('comparison_files').insert({ tenant_id: A,
    comparison_id: comp.data.id, source_file_id: file.fileId, side: 'current' })
  assert.equal(attached.error?.code, '23514')
})
test('actual unsupported bytes fail verification and never become ready', async () => {
  const file = await intent()
  assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(file.path,
    file.token, Buffer.alloc(bytes.length), { contentType: 'text/csv' })).error)
  await assert.rejects(finalizeUpload(gateway, users.editor!.token,
    { tenantId: A, fileId: file.fileId }), { status: 422 })
  const row = await db.query('select status, sha256 from public.source_files where id=$1', [file.fileId])
  assert.deepEqual(row.rows[0], { status: 'failed', sha256: null })
})
