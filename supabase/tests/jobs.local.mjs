// Native-only SQL authorization and competing-worker tests. No bootstrap schemas.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, test } from 'node:test'
import { Client } from 'pg'

const connection = { host:'127.0.0.1',port:54322,user:'postgres',password:'postgres',database:'postgres',ssl:false }
const db = new Client(connection)
const A=randomUUID(), B=randomUUID(), owner=randomUUID(), other=randomUUID(), viewer=randomUUID()
const a=randomUUID(), b=randomUUID(), comp=randomUUID(), compB=randomUUID(), worker=randomUUID()
const options={encoding:'utf-8-sig',delimiter:',',decimal_separator:'.',columns:{supplier_sku:'SKU',cost_price:'Price'}}
const failure={code:'storage_unavailable',stage:'load',message:'Local service unavailable',retryable:true}
async function role(client,user,which='authenticated') {
  await client.query(`set role ${which}`)
  await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user})])
}
async function rpc(name,args=[],client=db) {
  const placeholders=args.map((_,i)=>`$${i+1}`).join(',')
  return (await client.query(`select public.${name}(${placeholders}) as value`,
    args.map(x=>Array.isArray(x)?JSON.stringify(x):x))).rows[0].value
}
async function enqueue(max=3) {
  await role(db,owner)
  return rpc('enqueue_comparison_job',[A,comp,randomUUID(),options,options,max])
}
async function claim() { await role(db,null,'service_role'); return rpc('claim_csv_job',[worker]) }
function lease(j){return [j.tenant_id,j.id,worker,j.lease_token]}
async function denied(sql,args,code='42501') {
  await db.query('savepoint denied')
  try { await assert.rejects(db.query(sql,args.map(x=>Array.isArray(x)?JSON.stringify(x):x)),e=>e.code===code) }
  finally { await db.query('rollback to denied; release savepoint denied') }
}
function check(name,fn){test(name,async()=>{
  await db.query('begin')
  try { await fn() } finally { await db.query('rollback'); await db.query('reset role') }
})}
before(async()=>{
  await db.connect()
  await db.query('insert into auth.users(id) values ($1),($2),($3)',[owner,other,viewer])
  await db.query('insert into public.tenants(id,name) values ($1,$2),($3,$4)',[A,'Jobs A',B,'Jobs B'])
  await db.query(`insert into public.tenant_memberships(tenant_id,user_id,role)
    values ($1,$2,'owner'),($3,$4,'owner'),($1,$5,'viewer')`,[A,owner,B,other,viewer])
  for(const id of [a,b]) await db.query(`insert into public.source_files(id,tenant_id,created_by,
    original_filename,expected_byte_count,status,byte_count,verified_mime,sha256,finalized_at)
    values ($1,$2,$3,'file.csv',10,'ready',10,'text/csv',$4,now())`,[id,A,owner,'a'.repeat(64)])
  await db.query(`insert into public.comparisons(id,tenant_id,title,created_by)
    values($1,$2,'Jobs',$3),($4,$5,'Other',$6)`,[comp,A,owner,compB,B,other])
  await db.query(`insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side)
    values($1,$2,$3,'current'),($1,$2,$4,'incoming')`,[A,comp,a,b])
})
after(async()=>{await db.end()})

test('two independent workers cannot concurrently claim the same committed job',async()=>{
  await enqueue()
  await db.query('reset role')
  const first=new Client(connection),second=new Client(connection)
  await Promise.all([first.connect(),second.connect()])
  try {
    await Promise.all([role(first,null,'service_role'),role(second,null,'service_role')])
    const w1=randomUUID(),w2=randomUUID()
    const jobs=await Promise.all([rpc('claim_csv_job',[w1],first),rpc('claim_csv_job',[w2],second)])
    assert.equal(jobs.filter(Boolean).length,1)
    const j=jobs.find(Boolean),winner=jobs[0]?w1:w2
    const client=jobs[0]?first:second
    await rpc('complete_csv_job',[j.tenant_id,j.id,winner,j.lease_token,[]],client)
  } finally {await Promise.all([first.end(),second.end()])}
})
check('enqueue is idempotent and rejects key reuse with different settings',async()=>{
  await role(db,owner)
  const args=[A,comp,randomUUID(),options,options,3]
  const first=await rpc('enqueue_comparison_job',args)
  assert.equal((await rpc('enqueue_comparison_job',args)).id,first.id)
  await denied('select public.enqueue_comparison_job($1,$2,$3,$4,$5,$6)',
    [A,comp,args[2],{...options,delimiter:';'},options,3],'23514')
})
check('claim records an attempt, owner, token and bounded lease',async()=>{
  const enqueued=await enqueue(),j=await claim()
  assert.equal(j.id,enqueued.id);assert.equal(j.attempt_count,1);assert.equal(j.lease_owner,worker)
  assert.equal(j.status,'running');assert.ok(new Date(j.lease_expires_at)>new Date())
  assert.equal((await db.query('select status from public.job_attempts where job_id=$1',[j.id])).rows[0].status,'running')
})
check('expired lease is reclaimed with a new token and stale worker is fenced',async()=>{
  await enqueue();const first=await claim()
  await db.query('reset role')
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[first.id])
  const next=await claim()
  assert.equal(next.id,first.id);assert.equal(next.attempt_count,2);assert.notEqual(next.lease_token,first.lease_token)
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[...lease(first),[]])
  await denied('select public.heartbeat_csv_job($1,$2,$3,$4)',lease(first))
  assert.equal((await db.query('select status from public.job_attempts where lease_token=$1',[first.lease_token])).rows[0].status,'expired')
})
check('heartbeat extends active lease and cannot revive expired lease',async()=>{
  await enqueue();const j=await claim()
  const extended=await rpc('heartbeat_csv_job',[...lease(j),240])
  assert.ok(new Date(extended)>new Date(j.lease_expires_at))
  await db.query('reset role')
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id])
  await role(db,null,'service_role')
  await denied('select public.heartbeat_csv_job($1,$2,$3,$4)',lease(j))
})
check('retry schedules a later claim and preserves structured failure',async()=>{
  await enqueue();const j=await claim()
  const failed=await rpc('fail_csv_job',[...lease(j),failure,true])
  assert.equal(failed.status,'retry_wait');assert.deepEqual(failed.failure_reason,failure)
  assert.ok(new Date(failed.available_at)>new Date())
  assert.equal(await claim(),null)
  await db.query('reset role')
  await db.query("update public.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",[j.id])
  assert.equal((await claim()).attempt_count,2)
})
check('retry exhaustion becomes dead-letter with attempt failure details',async()=>{
  await enqueue(1);const j=await claim()
  assert.equal((await rpc('fail_csv_job',[...lease(j),failure,true])).status,'dead_letter')
  assert.equal(await claim(),null)
  const attempt=(await db.query('select failure_reason,status from public.job_attempts where job_id=$1',[j.id])).rows[0]
  assert.equal(attempt.status,'failed');assert.deepEqual(attempt.failure_reason,failure)
})
check('final expired attempt is dead-lettered by polling without another execution',async()=>{
  await enqueue(1);const j=await claim()
  await db.query('reset role')
  await db.query("update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[j.id])
  assert.equal(await claim(),null)
  assert.equal((await db.query('select status from public.jobs where id=$1',[j.id])).rows[0].status,'dead_letter')
})
check('nonretryable failure is terminal and never publishes results',async()=>{
  await enqueue();const j=await claim()
  assert.equal((await rpc('fail_csv_job',[...lease(j),failure,false])).status,'failed')
  assert.equal(await claim(),null)
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[j.comparison_run_id])).rows[0].n,0)
})
function result(run,overrides={}){
  return {id:randomUUID(),source_result_id:randomUUID(),outcome:'needs_review',review_state:'pending',
    change_flags:[],old_values:{source_file_id:a,record_id:randomUUID(),schema_version:'v1',evidence_ids:[]},
    new_values:null,cost_delta:null,cost_change_percent:null,percentage_state:'not_comparable',
    reasons:[{code:'missing_sku',message:'Missing identifier'}],provenance:[],...overrides}
}
check('completion is atomic and idempotent with exactly one result and pending candidate',async()=>{
  await enqueue();const j=await claim(),results=[result(j.comparison_run_id)]
  assert.equal((await rpc('complete_csv_job',[...lease(j),results])).status,'succeeded')
  assert.equal((await rpc('complete_csv_job',[...lease(j),results])).status,'succeeded')
  for(const table of ['comparison_results','match_candidates'])
    assert.equal((await db.query(`select count(*)::int as n from public.${table} where comparison_run_id=$1`,[j.comparison_run_id])).rows[0].n,1)
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[...lease(j),[]],'23514')
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[A,j.id,randomUUID(),j.lease_token,results])
})
check('invalid or cross-tenant result payload rolls back all staged results',async()=>{
  await enqueue();const j=await claim()
  const valid=result(j.comparison_run_id),invalid=result(j.comparison_run_id,{old_values:{source_file_id:randomUUID(),record_id:randomUUID(),schema_version:'v1',evidence_ids:[]}})
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[...lease(j),[valid,invalid]],'23514')
  assert.equal((await db.query('select count(*)::int as n from public.comparison_results where comparison_run_id=$1',[j.comparison_run_id])).rows[0].n,0)
  assert.equal((await db.query('select status from public.jobs where id=$1',[j.id])).rows[0].status,'running')
})
check('privileged worker cannot load, heartbeat, fail or complete a job under another tenant',async()=>{
  await enqueue();const j=await claim(),wrong=[B,j.id,worker,j.lease_token]
  for(const name of ['load_csv_job','heartbeat_csv_job']) await denied(`select public.${name}($1,$2,$3,$4)`,wrong)
  await denied('select public.fail_csv_job($1,$2,$3,$4,$5,$6)',[...wrong,failure,true])
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[...wrong,[]])
})
check('viewer and cross-tenant owner cannot enqueue, and browser cannot claim or complete',async()=>{
  const j=await enqueue()
  for(const user of [viewer,other]){
    await role(db,user)
    await denied('select public.enqueue_comparison_job($1,$2,$3,$4,$5)',[A,comp,randomUUID(),options,options])
  }
  await role(db,owner)
  await denied('select public.claim_csv_job($1)',[worker])
  await denied('select public.complete_csv_job($1,$2,$3,$4,$5)',[A,j.id,worker,randomUUID(),[]])
  await denied('update public.jobs set status=$1 where id=$2',['succeeded',j.id])
})
for(const table of ['jobs','job_attempts','comparison_runs','comparison_results','match_candidates']){
  check(`tenant B cannot read tenant A ${table}`,async()=>{
    await enqueue();const j=await claim();await rpc('complete_csv_job',[...lease(j),[result(j.comparison_run_id)]])
    await role(db,other)
    assert.equal((await db.query(`select * from public.${table} where tenant_id=$1`,[A])).rows.length,0)
    await role(db,viewer)
    assert.ok((await db.query(`select * from public.${table} where tenant_id=$1`,[A])).rows.length>0)
  })
}
check('tenant-aware foreign keys reject cross-tenant jobs and runs',async()=>{
  const j=await enqueue()
  await db.query('reset role')
  await db.query('delete from public.jobs where id=$1',[j.id])
  await denied('insert into public.jobs(tenant_id,comparison_run_id,idempotency_key) values($1,$2,$3)',[B,j.comparison_run_id,randomUUID()],'23503')
  await denied(`insert into public.comparison_runs(tenant_id,comparison_id,current_file_id,incoming_file_id,configuration)
    values($1,$2,$3,$4,$5)`,[B,compB,a,b,{}],'23503')
})
check('tenant-aware foreign keys reject cross-tenant result candidates and attempts',async()=>{
  await enqueue();const j=await claim(),row=result(j.comparison_run_id)
  await rpc('complete_csv_job',[...lease(j),[row]])
  await db.query('reset role')
  await db.query('delete from public.match_candidates where comparison_result_id=$1',[row.id])
  await denied(`insert into public.match_candidates(id,tenant_id,comparison_run_id,comparison_result_id,basis,candidate_data)
    values($1,$2,$3,$4,'unpaired_review','{}')`,[randomUUID(),B,j.comparison_run_id,row.id],'23503')
  await denied(`insert into public.job_attempts(tenant_id,job_id,attempt_number,lease_owner,lease_token,status)
    values($1,$2,2,$3,$4,'running')`,[B,j.id,worker,randomUUID()],'23503')
})
