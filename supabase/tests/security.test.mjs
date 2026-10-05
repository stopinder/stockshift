import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { test, before, after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// Native mode uses only the fixed, freshly reset local Supabase database.
// Never accept DATABASE_URL, PG* environment variables or a hosted connection.
const native = process.env.STOCKSHIFT_TEST_LOCAL_POSTGRES === '1'
const db = native ? await (async () => {
  const { Client } = await import('pg')
  const client = new Client({ host: '127.0.0.1', port: 54322, database: 'postgres',
    user: 'postgres', password: 'postgres', ssl: false })
  await client.connect()
  return {
    exec: sql => client.query(sql),
    query: async (sql, params) => {
      const result = await client.query(sql, params)
      return { rows: result.rows, affectedRows: result.rowCount }
    },
    close: () => client.end(),
  }
})() : new PGlite()
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const owner = '11111111-1111-4111-8111-111111111111'
const editor = '22222222-2222-4222-8222-222222222222'
const viewer = '33333333-3333-4333-8333-333333333333'
const other = '44444444-4444-4444-8444-444444444444'
const sourceA = '55555555-5555-4555-8555-555555555555'
const sourceB = '66666666-6666-4666-8666-666666666666'
const pending = '77777777-7777-4777-8777-777777777777'
const supplierB = '88888888-8888-4888-8888-888888888888'
const comparisonA = '99999999-9999-4999-8999-999999999999'
const comparisonB = '99999999-9999-4999-8999-999999999998'
const path = `${A}/${pending}/original`
const migrations = new URL('../migrations/', import.meta.url)

async function as(user, role = 'authenticated', extra = {}) {
  await db.exec(`set role ${role}`)
  await db.query("select set_config('request.jwt.claims', $1, false)",
    [JSON.stringify({ sub: user, ...extra })])
}
async function admin() { await db.exec('reset role') }
async function rows(sql, params = []) { return (await db.query(sql, params)).rows }
async function denied(sql, params = [], code = '42501') {
  // A savepoint lets the caller keep checking after an intentional SQL failure.
  await db.exec('savepoint rejection')
  try { await assert.rejects(db.query(sql, params), error => error.code === code) }
  finally { await db.exec('rollback to savepoint rejection') }
}
function check(name, fn) {
  test(name, async () => {
    await db.exec('savepoint test_case')
    try { await fn() } finally {
      await db.exec('rollback to savepoint test_case; release savepoint test_case')
      await admin()
    }
  })
}
before(async () => {
  if (!native) {
    await db.exec(await readFile(new URL('bootstrap.sql', import.meta.url), 'utf8'))
    for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await db.exec(await readFile(new URL(file, migrations), 'utf8'))
    }
  }
  // Native fixtures and every test are rolled back, preserving real service schemas.
  await db.exec('begin')
  await db.exec(`
    insert into auth.users(id) values ('${owner}'),('${editor}'),('${viewer}'),('${other}');
    insert into public.tenants(id,name) values ('${A}','Tenant A'),('${B}','Tenant B');
    insert into public.tenant_memberships(tenant_id,user_id,role) values
      ('${A}','${owner}','owner'),('${A}','${editor}','editor'),('${A}','${viewer}','viewer'),
      ('${B}','${other}','owner');
    insert into public.suppliers(id,tenant_id,name) values
      ('${A}','${A}','A supplier'),('${supplierB}','${B}','B supplier');
    insert into public.import_profiles(id,tenant_id,name,configuration) values
      ('${A}','${A}','A profile','{}'),('${B}','${B}','B profile','{}');
    insert into public.source_files(id,tenant_id,created_by,original_filename,expected_byte_count,
      status,byte_count,verified_mime,sha256,finalized_at) values
      ('${sourceA}','${A}','${editor}','a.csv',10,'ready',10,'text/csv','${'a'.repeat(64)}',now()),
      ('${sourceB}','${B}','${other}','b.csv',10,'ready',10,'text/csv','${'b'.repeat(64)}',now());
    insert into public.source_files(id,tenant_id,created_by,original_filename,expected_byte_count)
      values ('${pending}','${A}','${editor}','pending.csv',10);
    insert into public.comparisons(id,tenant_id,title,created_by) values
      ('${comparisonA}','${A}','A comparison','${editor}'),
      ('${comparisonB}','${B}','B comparison','${other}');
    insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values
      ('${A}','${comparisonA}','${sourceA}','current'),
      ('${B}','${comparisonB}','${sourceB}','current');
    insert into storage.objects(bucket_id,name,owner_id,metadata) values
      ('catalogue-uploads','${path}','${editor}','{"size":10}'),
      ('catalogue-uploads','${A}/${sourceA}/original','${editor}','{"size":10}'),
      ('catalogue-uploads','${B}/${sourceB}/original','${other}','{"size":10}');
  `)
})
after(async () => { await db.exec('rollback'); await db.close() })

check('migrations create exactly thirteen RLS-protected public tables', async () => {
  const tables = await rows(`select relname, relrowsecurity from pg_class c join pg_namespace n
    on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by relname`)
  assert.equal(tables.length, 13)
  assert.ok(tables.every(table => table.relrowsecurity))
})
for (const table of ['tenants', 'tenant_memberships', 'suppliers', 'source_files',
  'import_profiles', 'comparisons', 'comparison_files']) {
  check(`tenant A cannot read tenant B ${table}`, async () => {
    await as(viewer)
    const visible = await rows(`select * from public.${table}`)
    assert.ok(visible.length > 0)
    assert.ok(visible.every(row => (table === 'tenants' ? row.id : row.tenant_id) === A))
  })
}
check('anon has no public table access or upload RPC access', async () => {
  await as(null, 'anon')
  await denied('select * from public.tenants')
  await denied('select public.create_upload_intent($1,$2,10)', [A, 'file.csv'])
})
check('viewer cannot insert comparison or create upload intent', async () => {
  await as(viewer)
  await denied('insert into public.comparisons(tenant_id,title) values ($1,$2)', [A,'Denied'])
  await denied('select public.create_upload_intent($1,$2,10)', [A,'file.csv'])
})
check('viewer cannot edit supplier or comparison', async () => {
  await as(viewer)
  assert.equal((await db.query('update public.suppliers set name=$1 where tenant_id=$2', ['No',A])).affectedRows, 0)
  assert.equal((await db.query('update public.comparisons set title=$1 where tenant_id=$2', ['No',A])).affectedRows, 0)
})
check('editor can create comparison, supplier and import profile', async () => {
  await as(editor)
  assert.equal((await rows('insert into public.comparisons(tenant_id,title) values ($1,$2) returning created_by', [A,'Allowed']))[0].created_by, editor)
  await db.query('insert into public.suppliers(tenant_id,name) values ($1,$2)', [A,'Supplier'])
  await db.query('insert into public.import_profiles(tenant_id,name,configuration) values ($1,$2,$3)', [A,'Profile',{}])
})
check('editor upload intent uses registered user and immutable private path', async () => {
  await as(editor)
  const [row] = await rows('select public.create_upload_intent($1,$2,10) as file', [A,'file.csv'])
  assert.equal(row.file.created_by, editor)
  assert.equal(row.file.status, 'pending')
  assert.equal(row.file.object_name, `${A}/${row.file.id}/original`)
  assert.equal(row.file.sha256, null)
})
check('editor cannot forge comparison creator', async () => {
  await as(editor)
  await denied('insert into public.comparisons(tenant_id,title,created_by) values ($1,$2,$3)', [A,'No',owner])
})
check('owner can edit tenant name; editor cannot', async () => {
  await as(owner)
  assert.equal((await db.query('update public.tenants set name=$1 where id=$2', ['Changed',A])).affectedRows, 1)
  await as(editor)
  assert.equal((await db.query('update public.tenants set name=$1 where id=$2', ['No',A])).affectedRows, 0)
})
check('owner can manage other members through constrained RPC', async () => {
  await as(owner)
  await db.query('select public.manage_tenant_member($1,$2,$3)', [A,viewer,'editor'])
  assert.equal((await rows('select role from public.tenant_memberships where user_id=$1', [viewer]))[0].role,'editor')
})
check('self promotion, direct membership mutation and owner self deletion rejected', async () => {
  await as(editor)
  await denied('select public.manage_tenant_member($1,$2,$3)', [A,editor,'owner'])
  await denied('update public.tenant_memberships set role=$1 where user_id=$2', ['owner',editor])
  await as(owner)
  await denied('select public.manage_tenant_member($1,$2,null)', [A,owner])
})
check('owner cannot manage a different tenant and JWT metadata cannot grant ownership', async () => {
  await as(owner)
  await denied('select public.manage_tenant_member($1,$2,$3)', [B,viewer,'editor'])
  await as(viewer, 'authenticated', { user_metadata: { role:'owner', tenant_id:B } })
  await denied('select public.manage_tenant_member($1,$2,$3)', [A,editor,'owner'])
})
check('cross-tenant supplier/profile references fail composite foreign keys', async () => {
  await as(editor)
  await denied('insert into public.comparisons(tenant_id,title,supplier_id) values ($1,$2,$3)',
    [A,'No',supplierB], '23503')
  await denied('select public.create_upload_intent($1,$2,10,null,$3)', [A,'file.csv',B], '23503')
})
check('pending source cannot be attached or marked ready by browser', async () => {
  await as(editor)
  await denied('insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values ($1,$2,$3,$4)',
    [A,comparisonA,pending,'incoming'], '23514')
  await denied('update public.source_files set status=$1 where id=$2', ['ready',pending])
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,editor])
})
check('cross-tenant file association rejected', async () => {
  await as(editor)
  await denied('insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values ($1,$2,$3,$4)',
    [A,comparisonA,sourceB,'incoming'], '23514')
})
check('storage bucket is private, bounded and storage reads isolate tenants', async () => {
  assert.equal((await rows('select public from storage.buckets'))[0].public, false)
  await as(viewer)
  const visible = await rows('select name from storage.objects')
  assert.equal(visible.length, 2)
  assert.ok(visible.every(row => row.name.startsWith(`${A}/`)))
})
check('storage upload allows only creator editor registered pending path', async () => {
  await as(editor)
  const file = (await rows('select public.create_upload_intent($1,$2,10) as f', [A,'file.csv']))[0].f
  await db.query('insert into storage.objects(bucket_id,name,owner_id,metadata) values ($1,$2,$3,$4)',
    ['catalogue-uploads',file.object_name,editor,{size:10}])
  await denied('insert into storage.objects(bucket_id,name,owner_id) values ($1,$2,$3)',
    ['catalogue-uploads',`${B}/${file.id}/original`,editor])
  await denied('insert into storage.objects(bucket_id,name,owner_id) values ($1,$2,$3)',
    ['catalogue-uploads',`${A}/${file.id}/arbitrary.csv`,editor])
  await as(viewer)
  await denied('insert into storage.objects(bucket_id,name,owner_id) values ($1,$2,$3)',
    ['catalogue-uploads',`${A}/${file.id}/original`,viewer])
})
check('storage owner spoofing and client updates/deletes rejected', async () => {
  await as(editor)
  const file = (await rows('select public.create_upload_intent($1,$2,10) as f', [A,'file.csv']))[0].f
  await denied('insert into storage.objects(bucket_id,name,owner_id) values ($1,$2,$3)',
    ['catalogue-uploads',file.object_name,owner])
  assert.equal((await db.query('update storage.objects set name=$1 where name=$2', ['changed',path])).affectedRows, 0)
  if (native) {
    await denied('delete from storage.objects where name=$1', [path])
    // Match Storage API's transaction-local flag; RLS and our triggers stay active.
    await db.exec("set local storage.allow_delete_query = 'true'")
  }
  assert.equal((await db.query('delete from storage.objects where name=$1', [path])).affectedRows, 0)
})
check('service transition rechecks actual membership, tenant and actor ownership', async () => {
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [B,pending,editor])
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,viewer])
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,owner])
})
check('server finalization verifies state, bytes and hash and supports ready retries', async () => {
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'finish',10,'text/csv',$4)",
    [A,pending,editor,'a'.repeat(64)], '23514')
  await db.query("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,editor])
  await denied("select public.transition_catalogue_upload($1,$2,$3,'finish',9,'text/csv',$4)",
    [A,pending,editor,'a'.repeat(64)], '23514')
  const ready = (await rows("select public.transition_catalogue_upload($1,$2,$3,'finish',10,'text/csv',$4) as f",
    [A,pending,editor,'a'.repeat(64)]))[0].f
  assert.equal(ready.status,'ready')
  assert.equal(ready.sha256,'a'.repeat(64))
  const retry = (await rows("select public.transition_catalogue_upload($1,$2,$3,'begin') as f", [A,pending,editor]))[0].f
  assert.equal(retry.status,'ready')
})
check('finalized file/object cannot be reassigned, replaced or removed even by privileged paths', async () => {
  await denied('update public.source_files set tenant_id=$1 where id=$2', [B,sourceA], '23514')
  await denied('delete from public.source_files where id=$1', [sourceA], '23514')
  await as(null,'service_role')
  await denied('update storage.objects set name=$1 where name=$2',
    [`${B}/${sourceA}/original`,`${A}/${sourceA}/original`], '23514')
  if (native) {
    await denied('delete from storage.objects where name=$1', [`${A}/${sourceA}/original`])
    await db.exec("set local storage.allow_delete_query = 'true'")
  }
  await denied('delete from storage.objects where name=$1', [`${A}/${sourceA}/original`], '23514')
})
check('revoked membership prevents finalization', async () => {
  await db.query('update public.tenant_memberships set role=$1 where user_id=$2', ['viewer',editor])
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,editor])
})
check('missing object prevents finalization and leaves file pending', async () => {
  await as(editor)
  const file = (await rows('select public.create_upload_intent($1,$2,10) as f', [A,'missing.csv']))[0].f
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,file.id,editor], '23514')
  assert.equal((await rows('select status from public.source_files where id=$1', [file.id]))[0].status,'pending')
})
check('wrong Storage size or owner rejects finalization', async () => {
  await as(editor)
  const file = (await rows('select public.create_upload_intent($1,$2,10) as f', [A,'wrong.csv']))[0].f
  await admin()
  await db.query('insert into storage.objects(bucket_id,name,owner_id,metadata) values ($1,$2,$3,$4)',
    ['catalogue-uploads',file.object_name,editor,{size:9}])
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,file.id,editor], '23514')
  // A trusted fixture may seed a forged owner; application inserts cannot.
  await admin()
  const otherFile = (await rows(`insert into public.source_files(tenant_id,created_by,original_filename,
    expected_byte_count) values ($1,$2,$3,10) returning *`, [A,editor,'owner.csv']))[0]
  await db.query('insert into storage.objects(bucket_id,name,owner_id,metadata) values ($1,$2,$3,$4)',
    ['catalogue-uploads',otherFile.object_name,owner,{size:10}])
  await as(null,'service_role')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,otherFile.id,editor], '23514')
})
check('finalization requires valid SHA and supported MIME', async () => {
  await as(null,'service_role')
  await db.query("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,editor])
  await denied("select public.transition_catalogue_upload($1,$2,$3,'finish',10,'application/pdf',$4)",
    [A,pending,editor,'a'.repeat(64)], '23514')
  await denied("select public.transition_catalogue_upload($1,$2,$3,'finish',10,'text/csv',$4)",
    [A,pending,editor,'a'.repeat(64)+'\n'], '23514')
})
check('verified files can attach and failed files cannot', async () => {
  await as(null,'service_role')
  await db.query("select public.transition_catalogue_upload($1,$2,$3,'begin')", [A,pending,editor])
  await db.query("select public.transition_catalogue_upload($1,$2,$3,'fail')", [A,pending,editor])
  await as(editor)
  await denied('insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values ($1,$2,$3,$4)',
    [A,comparisonA,pending,'incoming'], '23514')
  const comp = (await rows('insert into public.comparisons(tenant_id,title) values ($1,$2) returning id', [A,'Ready']))[0]
  await db.query('insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values ($1,$2,$3,$4)',
    [A,comp.id,sourceA,'current'])
})
