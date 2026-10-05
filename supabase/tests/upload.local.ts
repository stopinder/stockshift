// Explicit local integration runner; never reads hosted credentials or URLs.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const csvOptions = { encoding:'utf-8-sig',delimiter:',',decimal_separator:'.',
  columns:{supplier_sku:'SKU',cost_price:'Price',description:'Description'},
  currency:'GBP',pack_quantity:'1',unit:'each',price_basis:'unit',tax_basis:'net' }
async function enqueueCsvPair(current: Buffer, incoming: Buffer, options = csvOptions) {
  const files = []
  for (const [index, content] of [current,incoming].entries()) {
    const file = await createUploadIntent(gateway, users.editor!.token,
      { tenantId:A,filename:`side${index}.csv`,byteCount:content.length })
    assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(file.path,
      file.token, content, { contentType:'text/csv' })).error)
    await finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:file.fileId})
    files.push(file.fileId)
  }
  const comp = await users.editor!.client.from('comparisons').insert({tenant_id:A,title:'Worker test'}).select().single()
  assert.ifError(comp.error)
  assert.ifError((await users.editor!.client.from('comparison_files').insert([
    {tenant_id:A,comparison_id:comp.data.id,source_file_id:files[0],side:'current'},
    {tenant_id:A,comparison_id:comp.data.id,source_file_id:files[1],side:'incoming'},
  ])).error)
  const result = await users.editor!.client.rpc('enqueue_comparison_job',{
    p_tenant:A,p_comparison:comp.data.id,p_key:randomUUID(),
    p_current_options:options,p_incoming_options:options,
  })
  assert.ifError(result.error)
  return result.data
}
function executeWorker() {
  const python = resolve('services/worker/.venv', process.platform==='win32'?'Scripts/python.exe':'bin/python')
  const result = spawnSync(python,['-m','stockshift_worker.entrypoints.cli','--once'],{
    env:{...env,STOCKSHIFT_LOCAL_SUPABASE_URL:url,STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY:config.secretKey},
    encoding:'utf8',timeout:60000,
  })
  assert.equal(result.status,0,`Local worker failed: ${result.stderr}`)
}
test('real Python worker processes the golden CSV fixture into 100 persisted results and two pending candidates',async()=>{
  const job = await enqueueCsvPair(readFileSync('tests/fixtures/csv/old_catalogue.csv'),
    readFileSync('tests/fixtures/csv/new_supplier_catalogue.csv'))
  executeWorker()
  const state=(await db.query('select status,attempt_count from public.jobs where id=$1',[job.id])).rows[0]
  assert.deepEqual(state,{status:'succeeded',attempt_count:1})
  const counts=(await db.query(`select primary_outcome,count(*)::int as n from public.comparison_results
    where comparison_run_id=$1 group by primary_outcome`,[job.comparison_run_id])).rows
  assert.deepEqual(Object.fromEntries(counts.map(r=>[r.primary_outcome,r.n])),
    {unchanged:50,changed:30,new:10,absent:8,needs_review:2})
  const review=(await db.query('select status,basis from public.match_candidates where comparison_run_id=$1',[job.comparison_run_id])).rows
  assert.equal(review.length,2);assert.ok(review.every(r=>r.status==='pending'&&r.basis==='unpaired_review'))
  const provenance=(await db.query(`select old_values,provenance from public.comparison_results
    where comparison_run_id=$1 and old_values is not null limit 1`,[job.comparison_run_id])).rows[0]
  assert.ok(provenance.provenance.length>0)
  assert.ok(provenance.provenance.some((e: {source_file_id:string})=>e.source_file_id===provenance.old_values.source_file_id))
  executeWorker()
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,100)
})
test('real worker persists exact decimal strings and undefined percentage for zero old cost',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n001,0.00,A\n002,1.2300,B\n'),
    Buffer.from('SKU,Price,Description\n001,1.2500,A\n002,1.2301,B\n'))
  executeWorker()
  const rows=(await db.query(`select old_values,cost_delta_text,cost_delta::text,
    cost_change_percent_text,percentage_state,reasons from public.comparison_results
    where comparison_run_id=$1`,[job.comparison_run_id])).rows
  const zero=rows.find(r=>r.old_values.supplier_sku==='001'),precise=rows.find(r=>r.old_values.supplier_sku==='002')
  assert.equal(zero.cost_delta_text,'1.2500');assert.equal(zero.percentage_state,'zero_old_cost')
  assert.equal(zero.cost_change_percent_text,null)
  assert.ok(zero.reasons.some((r: {code:string})=>r.code==='zero_old_cost'))
  assert.equal(precise.cost_delta_text,'0.0001');assert.equal(precise.cost_delta,'0.0001')
})
test('real worker persists structured terminal failure for invalid CSV mapping without publishing partial results',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n001,2,A\n'),
    Buffer.from('WRONG,Price,Description\n001,3,A\n'))
  executeWorker()
  const row=(await db.query('select status,failure_reason from public.jobs where id=$1',[job.id])).rows[0]
  assert.equal(row.status,'failed');assert.equal(row.failure_reason.code,'invalid_csv_job')
  assert.equal(row.failure_reason.stage,'parse');assert.equal(row.failure_reason.retryable,false)
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,0)
})
test('real worker recovers an abandoned lease and stale completion cannot duplicate output',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n001,2,A\n'),
    Buffer.from('SKU,Price,Description\n001,3,A\n'))
  const abandoned=randomUUID()
  const claimed=await admin.rpc('claim_csv_job',{p_worker:abandoned})
  assert.ifError(claimed.error);assert.equal(claimed.data.id,job.id)
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[job.id])
  executeWorker()
  const current=(await db.query('select status,attempt_count from public.jobs where id=$1',[job.id])).rows[0]
  assert.deepEqual(current,{status:'succeeded',attempt_count:2})
  const stale=await admin.rpc('complete_csv_job',{p_tenant:A,p_job:job.id,p_worker:abandoned,
    p_token:claimed.data.lease_token,p_results:[]})
  assert.equal(stale.error?.code,'42501')
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,1)
  const attempts=(await db.query('select status from public.job_attempts where job_id=$1 order by attempt_number',[job.id])).rows
  assert.deepEqual(attempts,[{status:'expired'},{status:'succeeded'}])
})
