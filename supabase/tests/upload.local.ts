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
import { createServer } from 'node:http'
import exportHandler from '../../apps/web/server/export'
import pdfHandler from "../../apps/web/api/pdf"
import workbookHandler from '../../apps/web/api/workbook'
import { XLSX_MIME } from '../../apps/web/server/workbook'

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_)/i.test(key)))
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
const exportServer = createServer(exportHandler)
let exportUrl = ''

before(async () => {
  process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED='1'
  Object.assign(process.env, { STOCKSHIFT_LOCAL_SUPABASE_URL: url,
    STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: config.secretKey })
  await new Promise<void>(resolve => exportServer.listen(0, '127.0.0.1', resolve))
  const address = exportServer.address()
  assert.ok(address && typeof address === 'object')
  exportUrl = `http://127.0.0.1:${address.port}`
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
  // This shared stress fixture exercises more than trial upload/comparison limits.
  // Fresh non-exempt quota enforcement is covered by allowance.local + browser acceptance.
  await db.query('update public.workspace_allowances set pilot_exempt=true where tenant_id in ($1,$2)', [A,B])
  for (const role of ['owner', 'editor', 'viewer', 'other']) {
    await db.query('insert into public.tenant_memberships(tenant_id,user_id,role) values ($1,$2,$3)',
      [role === 'other' ? B : A, users[role]!.id, role === 'other' ? 'owner' : role])
  }
})
after(async () => { await db.end(); await new Promise<void>((resolve, reject) => exportServer.close(e => e ? reject(e) : resolve())) })

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
  assert.deepEqual(data!.allowed_mime_types, ['text/csv','application/octet-stream','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/pdf'])
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
function executeSingleWorker() {
  const python = resolve('services/worker/.venv', process.platform==='win32'?'Scripts/python.exe':'bin/python')
  const result = spawnSync(python,['-m','stockshift_worker.entrypoints.cli','--once'],{
    env:{...env,STOCKSHIFT_SUPABASE_MODE:"local",STOCKSHIFT_LOCAL_SUPABASE_URL:url,STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY:config.secretKey},
    encoding:'utf8',timeout:60000,
  })
  assert.equal(result.status,0,`Local worker failed: ${result.stderr}`)
}
async function executeWorker() {
  // Finalization now enqueues CPU inspection before a separately requested extraction.
  // Drain only this suite's bounded test-owned queue; never claim unrelated work.
  const outsiders=await db.query("select count(*)::int n from public.jobs where tenant_id<>$1 and status in ('queued','running','retry_wait')",[A])
  assert.equal(outsiders.rows[0].n,0,'Unrelated unfinished jobs must not be consumed')
  for(let attempt=0;attempt<10;attempt++) {
    const pending=await db.query("select count(*)::int n from public.jobs where tenant_id=$1 and status in ('queued','running','retry_wait')",[A])
    if(!pending.rows[0].n) return
    executeSingleWorker()
  }
  assert.fail('Test-owned queue did not drain within ten jobs')
}

test('real Python worker processes the golden CSV fixture into 100 persisted results and two pending candidates',async()=>{
  const job = await enqueueCsvPair(readFileSync('tests/fixtures/csv/old_catalogue.csv'),
    readFileSync('tests/fixtures/csv/new_supplier_catalogue.csv'))
  await executeWorker()
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
  await executeWorker()
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,100)
})
test('real worker persists exact decimal strings and undefined percentage for zero old cost',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n001,0.00,A\n002,1.2300,B\n'),
    Buffer.from('SKU,Price,Description\n001,1.2500,A\n002,1.2301,B\n'))
  await executeWorker()
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
  await executeWorker()
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
  await executeWorker()
  const current=(await db.query('select status,attempt_count from public.jobs where id=$1',[job.id])).rows[0]
  assert.deepEqual(current,{status:'succeeded',attempt_count:2})
  const stale=await admin.rpc('complete_csv_job',{p_tenant:A,p_job:job.id,p_worker:abandoned,
    p_token:claimed.data.lease_token,p_results:[]})
  assert.equal(stale.error?.code,'42501')
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,1)
  const attempts=(await db.query('select status from public.job_attempts where job_id=$1 order by attempt_number',[job.id])).rows
  assert.deepEqual(attempts,[{status:'expired'},{status:'succeeded'}])
})

function exportRequest(run: string, role='editor', tenant=A) {
  return fetch(`${exportUrl}/api/export?tenant=${tenant}&run=${run}`, { headers: { Authorization: `Bearer ${users[role]!.token}` } })
}
test('real HTTP export is blocked until audited review, then preserves precision and protects formula text',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n000012,0.0000,Old\n=cmd,1.2300,Safe\n,2,Missing identifier\n'),
    Buffer.from('SKU,Price,Description\n000012,1.2500,New\n=cmd,1.2301,=formula\n,3,Missing identifier\n'))
  await executeWorker()
  const blocked=await exportRequest(job.comparison_run_id)
  assert.equal(blocked.status,409)
  const reviews=await users.editor!.client.rpc('csv_results_page',{p_tenant:A,p_run:job.comparison_run_id,p_outcome:'needs_review'})
  assert.ifError(reviews.error);assert.equal(reviews.data.length,2)
  for(const row of reviews.data) {
    const resolved=await users.editor!.client.rpc('resolve_csv_review',{p_tenant:A,p_run:job.comparison_run_id,
      p_result:row.id,p_decision:'no_match',p_note:'Missing identifier; exclude from update'})
    assert.ifError(resolved.error)
  }
  const response=await exportRequest(job.comparison_run_id)
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
  assert.match(response.headers.get('content-disposition')!, /changed_products\.csv/)
  const csv=await response.text()
  assert.ok(csv.includes('"000012"'));assert.ok(csv.includes('"0.0000","1.2500","1.2500","","zero_old_cost"'))
  assert.ok(csv.includes('"\'=cmd"'));assert.ok(csv.includes('"\'=formula"'));assert.ok(csv.includes('"0.0001"'))
  assert.equal(csv.split('\r\n').filter(Boolean).length,3);assert.ok(!csv.includes('Missing identifier'))
  const reload=await users.editor!.client.rpc('csv_run_summary',{p_tenant:A,p_run:job.comparison_run_id})
  assert.ifError(reload.error);assert.equal(reload.data.unresolved,0);assert.equal(reload.data.excluded,2)
})
test('real HTTP export rejects missing and invalid sessions without leaking keys',async()=>{
  for(const headers of [{},{Authorization:'Bearer invalid-session'}]) {
    const response=await fetch(`${exportUrl}/api/export?tenant=${A}&run=${randomUUID()}`,{headers})
    assert.equal(response.status,401);assert.ok(!(await response.text()).includes(config.secretKey))
  }
})
test('real HTTP export rejects another tenant even using a valid session',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n01,1,A\n'),Buffer.from('SKU,Price,Description\n01,2,A\n'))
  await executeWorker()
  assert.equal((await exportRequest(job.comparison_run_id,'other')).status,403)
})
test('real HTTP export supports empty completed results with header only',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n'),Buffer.from('SKU,Price,Description\n'))
  await executeWorker();const response=await exportRequest(job.comparison_run_id)
  assert.equal(response.status,200);assert.equal((await response.text()).split('\r\n').filter(Boolean).length,1)
})
test('real HTTP export rejects failed and queued runs',async()=>{
  const job=await enqueueCsvPair(Buffer.from('SKU,Price,Description\n01,1,A\n'),Buffer.from('Wrong,Price,Description\n01,2,A\n'))
  assert.equal((await exportRequest(job.comparison_run_id)).status,409)
  await executeWorker();assert.equal((await exportRequest(job.comparison_run_id)).status,409)
})
test('real HTTP export rejects unsupported methods and malformed selection',async()=>{
  assert.equal((await fetch(`${exportUrl}/api/export`,{method:'POST'})).status,405)
  assert.equal((await fetch(`${exportUrl}/api/export?tenant=invalid&run=invalid`,{headers:{Authorization:`Bearer ${users.editor!.token}`}})).status,400)
})

// XLSX exercises the same real Auth, immutable Storage, tenant RLS, Python job and CSV export paths.
function xlsxBytes(...args: string[]) {
  return Buffer.from(execFileSync(resolve('services/worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
    ['services/worker/tests/workbook_fixture.py',...args],{env,encoding:'utf8'}).trim(),'base64')
}
async function uploadedXlsx(data=xlsxBytes()) {
  const file=await createUploadIntent(gateway,users.editor!.token,{tenantId:A,filename:'catalogue.xlsx',byteCount:data.length})
  assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(file.path,file.token,data,{contentType:XLSX_MIME})).error)
  await finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:file.fileId})
  return file
}
const xlsxOptions={...csvOptions,format:'xlsx',worksheet:'Products',header_row:2,
  columns:{supplier_sku:'SKU',cost_price:'Price',description:'Description',currency:'Currency',pack_quantity:'Pack',unit:'UOM'}}
async function xlsxComparison(formula=false) {
  const files=[await uploadedXlsx(),await uploadedXlsx(xlsxBytes('incoming',...(formula?['formula']:[])))]
  const comp=await users.editor!.client.from('comparisons').insert({tenant_id:A,title:'XLSX persisted comparison'}).select().single()
  assert.ifError(comp.error)
  for(let i=0;i<2;i++) assert.ifError((await users.editor!.client.from('comparison_files').insert({tenant_id:A,
    comparison_id:comp.data.id,source_file_id:files[i]!.fileId,side:i===0?'current':'incoming'})).error)
  return {comparison:comp.data.id,files}
}
async function previewRequest(fileId:string,role='editor',extra:Record<string,unknown>={}) {
  const res={statusCode:0,output:'',setHeader(){},end(value:string){this.output=value}}
  await workbookHandler({method:'POST',headers:{authorization:`Bearer ${users[role]!.token}`},body:{tenantId:A,fileId,...extra}} as Parameters<typeof workbookHandler>[0],res as unknown as Parameters<typeof workbookHandler>[1])
  return {status:res.statusCode,body:JSON.parse(res.output)}
}
test('real XLSX upload finalizes with authoritative MIME and discovery',async()=>{
  const file=await uploadedXlsx()
  const ready=await finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:file.fileId})
  assert.equal(ready.mime,XLSX_MIME)
  const preview=await previewRequest(file.fileId)
  assert.equal(preview.status,200)
  assert.deepEqual(preview.body.worksheets.map((s:{name:string})=>s.name),['Notes','Products','Hidden','Empty'])
  assert.equal(preview.body.headers,undefined)
})
test('XLSX preview validates tenant access, hidden/empty worksheets and explicit header selection',async()=>{
  const file=await uploadedXlsx()
  const preview=await previewRequest(file.fileId,'viewer',{worksheet:'Products',headerRow:2})
  assert.equal(preview.status,200);assert.equal(preview.body.samples[0][0],'00123')
  assert.equal((await previewRequest(file.fileId,'other')).status,403)
  for(const worksheet of ['Hidden','Empty','Missing']) assert.equal((await previewRequest(file.fileId,'editor',{worksheet,headerRow:2})).status,422)
  assert.equal((await previewRequest(file.fileId,'editor',{worksheet:'Products',headerRow:0})).status,400)
})
test('XLSX enqueue requires worksheet/format and disallows browser worker mutation',async()=>{
  const c=await xlsxComparison()
  for(const options of [csvOptions,{...xlsxOptions,worksheet:''},{...xlsxOptions,header_row:0}]) {
    const r=await users.editor!.client.rpc('enqueue_comparison_job',{p_tenant:A,p_comparison:c.comparison,p_key:randomUUID(),p_current_options:options,p_incoming_options:options})
    assert.equal(r.error?.code,'23514')
  }
  assert.ok((await users.editor!.client.rpc('claim_csv_job',{p_worker:randomUUID()})).error)
})
test('XLSX durable job persists precision, leading zeros, worksheet provenance, review and unchanged CSV export',async()=>{
  const c=await xlsxComparison()
  const queued=await users.editor!.client.rpc('enqueue_comparison_job',{p_tenant:A,p_comparison:c.comparison,p_key:randomUUID(),p_current_options:xlsxOptions,p_incoming_options:xlsxOptions})
  assert.ifError(queued.error)
  await executeWorker()
  const job=queued.data
  assert.equal((await db.query('select status from public.jobs where id=$1',[job.id])).rows[0].status,'succeeded')
  const results=await users.editor!.client.rpc('csv_results_page',{p_tenant:A,p_run:job.comparison_run_id})
  assert.ifError(results.error);assert.equal(results.data.length,4)
  const changed=results.data.find((r:{primary_outcome:string})=>r.primary_outcome==='changed')
  assert.equal(changed.new_values.supplier_sku,'00123')
  assert.equal(changed.cost_delta_text,'0.001000000000000001')
  assert.ok(changed.provenance.every((e:{locator:{sheet:string;row:number}})=>e.locator.sheet==='Products'&&e.locator.row===3))
  assert.equal(results.data.find((r:{primary_outcome:string})=>r.primary_outcome==='unchanged').new_values.supplier_sku,'00042')
  assert.equal((await exportRequest(job.comparison_run_id)).status,409)
  for(const r of results.data.filter((r:{review_state:string})=>r.review_state==='pending')) assert.ifError((await users.editor!.client.rpc('resolve_csv_review',{p_tenant:A,p_run:job.comparison_run_id,p_result:r.id,p_decision:'no_match',p_note:'Missing workbook price; exclude'})).error)
  const exported=await exportRequest(job.comparison_run_id)
  assert.equal(exported.status,200);assert.match(await exported.text(),/0\.001000000000000001/)
  const other=await users.other!.client.rpc('csv_results_page',{p_tenant:A,p_run:job.comparison_run_id})
  assert.ifError(other.error);assert.equal(other.data.length,0)
  await executeWorker()
  assert.equal((await db.query('select count(*)::int n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,4)
})
test('XLSX formula job stores actionable terminal failure and never publishes partial results',async()=>{
  const c=await xlsxComparison(true)
  const queued=await users.editor!.client.rpc('enqueue_comparison_job',{p_tenant:A,p_comparison:c.comparison,p_key:randomUUID(),p_current_options:xlsxOptions,p_incoming_options:xlsxOptions})
  assert.ifError(queued.error);await executeWorker()
  const job=(await db.query('select status,failure_reason from public.jobs where id=$1',[queued.data.id])).rows[0]
  assert.equal(job.status,'failed');assert.equal(job.failure_reason.code,'invalid_xlsx_job');assert.match(job.failure_reason.message,/formula/)
  assert.equal((await db.query('select count(*)::int n from public.comparison_results where comparison_run_id=$1',[queued.data.comparison_run_id])).rows[0].n,0)
})
test('corrupt and password protected XLSX never finalize as ready',async()=>{
  for(const data of [Buffer.from('PK\x03\x04corrupt'),Buffer.from('d0cf11e0a1b11ae1','hex')]) {
    const file=await createUploadIntent(gateway,users.editor!.token,{tenantId:A,filename:'invalid.xlsx',byteCount:data.length})
    assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(file.path,file.token,data,{contentType:XLSX_MIME})).error)
    await assert.rejects(finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:file.fileId}),{status:422})
    assert.equal((await db.query('select status from public.source_files where id=$1',[file.fileId])).rows[0].status,'failed')
  }
})

test('mixed CSV and XLSX inputs share durable results and record contracts',async()=>{
  const first=Buffer.from('SKU,Price,Description\n00123,1.001000000000000000,Precision component\n')
  const a=await createUploadIntent(gateway,users.editor!.token,{tenantId:A,filename:'current.csv',byteCount:first.length})
  assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(a.path,a.token,first,{contentType:'text/csv'})).error)
  await finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:a.fileId})
  const b=await uploadedXlsx(xlsxBytes('incoming'))
  const comp=await users.editor!.client.from('comparisons').insert({tenant_id:A,title:'Mixed format'}).select().single()
  assert.ifError(comp.error)
  for(const [side,file] of [['current',a],['incoming',b]] as const) assert.ifError((await users.editor!.client.from('comparison_files').insert({tenant_id:A,comparison_id:comp.data.id,source_file_id:file.fileId,side})).error)
  const queued=await users.editor!.client.rpc('enqueue_comparison_job',{p_tenant:A,p_comparison:comp.data.id,p_key:randomUUID(),p_current_options:csvOptions,p_incoming_options:xlsxOptions})
  assert.ifError(queued.error);await executeWorker()
  const rows=(await db.query('select primary_outcome,cost_delta_text,provenance from public.comparison_results where comparison_run_id=$1',[queued.data.comparison_run_id])).rows
  const changed=rows.find(r=>r.primary_outcome==='changed')
  assert.equal(changed.cost_delta_text,'0.001000000000000001')
  assert.ok(changed.provenance.some((e:{locator:{sheet:null}})=>e.locator.sheet===null))
  assert.ok(changed.provenance.some((e:{locator:{sheet:string}})=>e.locator.sheet==='Products'))
})

function pdfBytes(mode = '') {
 const python=resolve('services/worker/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')
 return Buffer.from(execFileSync(python,['services/worker/tests/pdf_fixture.py',mode],{env,encoding:'utf8'}).trim(),'base64')
}
async function uploadedPdf(data=pdfBytes()) {
 const file=await createUploadIntent(gateway,users.editor!.token,{tenantId:A,filename:'catalogue.pdf',byteCount:data.length})
 assert.ifError((await users.editor!.client.storage.from(bucket).uploadToSignedUrl(file.path,file.token,data,{contentType:'application/pdf'})).error)
 await finalizeUpload(gateway,users.editor!.token,{tenantId:A,fileId:file.fileId})
 return file
}
async function pdfExtraction(data=pdfBytes()) {
 const file=await uploadedPdf(data)
 const response=await users.editor!.client.rpc('enqueue_pdf_extraction',{p_tenant:A,p_file:file.fileId,p_configuration:{first_page:1,last_page:2,strategy:'lines'}})
 assert.ifError(response.error);await executeWorker()
 const row=(await db.query('select * from public.extraction_runs where id=$1',[response.data.extraction.id])).rows[0]
 return {file,row,job:response.data.job}
}
const pdfConfiguration={...csvOptions,columns:{supplier_sku:'SKU',cost_price:'Price',description:'Description',currency:'Currency',pack_quantity:'Pack',unit:'UOM'},currency:null,unit:null,pack_quantity:null,table_index:1,header_row:1,repeat_headers:true,structure_confirmed:true}
async function pdfRevision(row:any,corrections:object={},expected=0,confirmed=true) {
 const response=await users.editor!.client.rpc('save_pdf_revision',{p_tenant:A,p_extraction:row.id,p_expected:expected,p_configuration:pdfConfiguration,p_corrections:corrections,p_confirmed:confirmed})
 assert.ifError(response.error);return response.data
}
test('PDF signed upload finalizes privately; exact PDF bytes are tenant-isolated',async()=>{
 const data=pdfBytes(),file=await uploadedPdf(data)
 const registered=(await db.query('select verified_mime,sha256 from public.source_files where id=$1',[file.fileId])).rows[0]
 assert.equal(registered.verified_mime,'application/pdf');assert.equal(registered.sha256,createHash('sha256').update(data).digest('hex'))
 assert.ok((await users.other!.client.storage.from(bucket).download(file.path)).error)
 assert.ok(!(await fetch(`${url}/storage/v1/object/public/${bucket}/${file.path}`)).ok)
 const read=await users.viewer!.client.storage.from(bucket).download(file.path);assert.ifError(read.error)
 assert.deepEqual(Buffer.from(await read.data!.arrayBuffer()),data)
})
test('PDF corrupt/encrypted bytes verify but CPU inspection fails terminally',async()=>{
 for(const data of [Buffer.from('%PDF-1.7 corrupt'),pdfBytes('encrypted')]) {
  const file=await uploadedPdf(data)
  await executeWorker()
  const source=(await db.query('select status from public.source_files where id=$1',[file.fileId])).rows[0]
  const inspection=(await db.query('select status,diagnostics from public.pdf_inspections where source_file_id=$1',[file.fileId])).rows[0]
  assert.equal(source.status,'ready');assert.equal(inspection.status,'failed');assert.equal(inspection.diagnostics,null)
 }
})

test('real PDF extraction job stores all pages, measured progress and immutable original cell evidence',async()=>{
 const x=await pdfExtraction();assert.equal(x.row.status,'ready');assert.equal(x.row.completed_pages,2);assert.equal(x.row.total_pages,2)
 assert.equal(x.row.payload.records.length,5);assert.deepEqual(x.row.raw_pages.map((p:any)=>p.page),[1,2])
 assert.ok(x.row.payload.evidence.every((e:any)=>e.source_file_id===x.file.fileId&&e.locator.bounding_polygon.length===4))
 assert.equal((await db.query('select status,attempt_count from public.jobs where id=$1',[x.job.id])).rows[0].status,'succeeded')
 await assert.rejects(db.query("update public.extraction_runs set payload='{}' where id=$1",[x.row.id]),e=>(e as {code:string}).code==='23514')
 await assert.rejects(db.query('delete from public.extraction_runs where id=$1',[x.row.id]),e=>(e as {code:string}).code==='23514')
 const repeat=await users.editor!.client.rpc('enqueue_pdf_extraction',{p_tenant:A,p_file:x.file.fileId,p_configuration:{first_page:1,last_page:2,strategy:'lines'}})
 assert.ifError(repeat.error);assert.equal(repeat.data.job.id,x.job.id)
})
test('PDF correction revisions persist original/corrected values, actor/time and optimistic conflicts',async()=>{
 const x=await pdfExtraction(pdfBytes('incoming')),id=x.row.payload.records[1].record_id
 const draft=await pdfRevision(x.row,{[id]:{cost_price:'1.002000000000000001'}},0,false)
 assert.equal(draft.revision,1);assert.equal(draft.created_by,users.editor!.id);assert.ok(draft.created_at)
 const conflict=await users.editor!.client.rpc('save_pdf_revision',{p_tenant:A,p_extraction:x.row.id,p_expected:0,p_configuration:pdfConfiguration,p_corrections:{},p_confirmed:true})
 assert.equal(conflict.error?.code,'23514')
 const final=await pdfRevision(x.row,draft.corrections,1)
 assert.equal(final.revision,2);assert.equal(final.confirmed,true)
 const reload=await users.viewer!.client.from('correction_revisions').select('*').eq('id',final.id).single();assert.ifError(reload.error);assert.deepEqual(reload.data.corrections,draft.corrections)
 assert.equal((await db.query('select payload from public.extraction_runs where id=$1',[x.row.id])).rows[0].payload.records[1].raw_cells[1].value,'1.2O')
 await assert.rejects(db.query("update public.correction_revisions set corrections='{}' where id=$1",[final.id]),e=>(e as {code:string}).code==='23514')
 await assert.rejects(db.query('delete from public.correction_revisions where id=$1',[final.id]),e=>(e as {code:string}).code==='23514')
})
test('PDF extraction/corrections enforce RLS and reject direct browser worker mutations',async()=>{
 const x=await pdfExtraction(),v=await pdfRevision(x.row)
 for(const table of ['extraction_runs','correction_revisions']) {
  const other=await users.other!.client.from(table).select('*').eq('tenant_id',A);assert.ifError(other.error);assert.equal(other.data!.length,0)
  assert.ok((await users.editor!.client.from(table).update({tenant_id:B}).eq('id',table==='extraction_runs'?x.row.id:v.id)).error)
 }
 for(const role of ['viewer','other']) {
  assert.equal((await users[role]!.client.rpc('enqueue_pdf_extraction',{p_tenant:A,p_file:x.file.fileId,p_configuration:{first_page:1,last_page:2,strategy:'lines'}})).error?.code,'42501')
  assert.equal((await users[role]!.client.rpc('save_pdf_revision',{p_tenant:A,p_extraction:x.row.id,p_expected:1,p_configuration:pdfConfiguration,p_corrections:{},p_confirmed:true})).error?.code,'42501')
 }
 for(const name of ['load_pdf_extraction','complete_pdf_extraction','pdf_extraction_progress']) {
  const params={p_tenant:A,p_job:x.job.id,p_worker:randomUUID(),p_token:randomUUID(),...(name==='complete_pdf_extraction'?{p_payload:x.row.payload,p_pages:x.row.raw_pages}:{}),...(name==='pdf_extraction_progress'?{p_completed:1,p_total:2}:{})}
  assert.ok((await users.editor!.client.rpc(name,params)).error)
 }
})
test('image-only PDF durably enters OCR-required and cannot be confirmed',async()=>{
 const x=await pdfExtraction(pdfBytes('image'))
 assert.equal(x.row.status,'ocr_required');assert.equal(x.row.payload.completion.state,'incomplete');assert.equal(x.row.payload.records.length,0)
 const v=await users.editor!.client.rpc('save_pdf_revision',{p_tenant:A,p_extraction:x.row.id,p_expected:0,p_configuration:pdfConfiguration,p_corrections:{},p_confirmed:true})
 assert.equal(v.error?.code,'42501')
})
test('PDF corrections reject invalid decimals, blank identifiers and records outside extraction',async()=>{
 const x=await pdfExtraction(),id=x.row.payload.records[1].record_id
 for(const corrections of [{[id]:{cost_price:'NaN'}},{[id]:{supplier_sku:''}},{[randomUUID()]:{cost_price:'2'}},{[id]:{currency:'gbp'}},{[id]:{tenant_id:B}}]) {
  const r=await users.editor!.client.rpc('save_pdf_revision',{p_tenant:A,p_extraction:x.row.id,p_expected:0,p_configuration:pdfConfiguration,p_corrections:corrections,p_confirmed:true});assert.equal(r.error?.code,'23514')
 }
})
test('digital PDF comparison uses confirmed correction snapshot, exact persisted results, review and trusted export',async()=>{
 const a=await pdfExtraction(),b=await pdfExtraction(pdfBytes('incoming'))
 const ar=await pdfRevision(a.row),record=b.row.payload.records[1].record_id
 const br=await pdfRevision(b.row,{[record]:{cost_price:'1.002000000000000001'}})
 const comp=await users.editor!.client.from('comparisons').insert({tenant_id:A,title:'Digital PDF correction comparison'}).select().single();assert.ifError(comp.error)
 assert.ifError((await users.editor!.client.from('comparison_files').insert([{tenant_id:A,comparison_id:comp.data.id,source_file_id:a.file.fileId,side:'current'},{tenant_id:A,comparison_id:comp.data.id,source_file_id:b.file.fileId,side:'incoming'}])).error)
 const request={p_tenant:A,p_comparison:comp.data.id,p_key:randomUUID(),p_current_options:{format:'pdf',revision_id:ar.id},p_incoming_options:{format:'pdf',revision_id:br.id}}
 const queued=await users.editor!.client.rpc('enqueue_comparison_job',request);assert.ifError(queued.error)
 // A later confirmed revision cannot change the already queued comparison snapshot.
 await pdfRevision(b.row,{[record]:{cost_price:'99'}},1)
 await executeWorker();const job=queued.data
 assert.equal((await db.query('select status from public.jobs where id=$1',[job.id])).rows[0].status,'succeeded')
 const response=await users.editor!.client.rpc('csv_results_page',{p_tenant:A,p_run:job.comparison_run_id});assert.ifError(response.error)
 assert.equal(response.data.length,4)
 const changed=response.data.find((r:any)=>r.primary_outcome==='changed');assert.equal(changed.new_values.supplier_sku,'00123');assert.equal(changed.new_values.cost_price,'1.002000000000000001');assert.equal(changed.cost_delta_text,'0.001000000000000001')
 assert.ok(changed.provenance.some((e:any)=>e.raw_text==='1.2O'&&e.locator.page===1&&e.locator.column==='Price'))
 assert.equal((await exportRequest(job.comparison_run_id)).status,409)
 for(const r of response.data.filter((r:any)=>r.review_state==='pending')) assert.ifError((await users.editor!.client.rpc('resolve_csv_review',{p_tenant:A,p_run:job.comparison_run_id,p_result:r.id,p_decision:'no_match',p_note:'Missing PDF price; exclude'})).error)
 const exported=await exportRequest(job.comparison_run_id);assert.equal(exported.status,200);assert.match(await exported.text(),/0\.001000000000000001/)
 const duplicate=await users.editor!.client.rpc('enqueue_comparison_job',request);assert.ifError(duplicate.error);assert.equal(duplicate.data.id,job.id);await executeWorker()
 assert.equal((await db.query('select count(*)::int n from public.comparison_results where comparison_run_id=$1',[job.comparison_run_id])).rows[0].n,4)
 const other=await users.other!.client.rpc('csv_results_page',{p_tenant:A,p_run:job.comparison_run_id});assert.ifError(other.error);assert.equal(other.data.length,0)
})

test('PDF persisted inspection status authenticates and uses tenant RLS',async()=>{
 const file=await uploadedPdf()
 for(const role of ['editor','viewer','other']) {
  const res={statusCode:0,output:'',setHeader(){},end(value:string){this.output=value}}
  await pdfHandler({method:'POST',headers:{authorization:`Bearer ${users[role]!.token}`},body:{tenantId:A,fileId:file.fileId}} as Parameters<typeof pdfHandler>[0],res as unknown as Parameters<typeof pdfHandler>[1])
  assert.equal(res.statusCode,role==='other'?403:200)
  if(role!=='other') assert.deepEqual(JSON.parse(res.output),{fileId:file.fileId,byteVerification:'verified',inspection:{id:JSON.parse(res.output).inspection.id,status:'queued',pageCount:null,diagnostics:null,failure:null},comparisonEligibility:'requires_confirmed_extraction'})
 }
 await executeWorker()
})
