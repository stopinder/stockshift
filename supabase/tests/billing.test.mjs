import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
test('billing records are owner-scoped, service-only writes are checked and events are idempotent',async()=>{
 const db=new PGlite();try{
 await db.exec(await readFile(new URL('bootstrap.sql',import.meta.url),'utf8'));
 for(const file of ['20261005141354_tenant_upload_foundations.sql','20261007133637_stripe_billing_foundation.sql'])await db.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
 const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',u='11111111-1111-4111-8111-111111111111',v='22222222-2222-4222-8222-222222222222';
 await db.query('insert into auth.users(id) values($1),($2)',[u,v]);await db.query("insert into public.tenants(id,name) values($1,'A'),($2,'B')",[a,b]);await db.query("insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",[a,u,b,v]);
 await db.exec('set role service_role');await db.query("insert into public.billing_accounts(tenant_id,stripe_customer_id) values($1,'cus_A'),($2,'cus_B')",[a,b]);
 await db.query("select public.record_stockshift_subscription('evt_A',$1,'cus_A','sub_A','active','2026-11-07T00:00:00Z',false)",[a]);
 await db.query("select public.record_stockshift_subscription('evt_A',$1,'cus_A','sub_A','canceled','2026-11-07T00:00:00Z',false)",[a]);
 assert.equal((await db.query('select status from public.workspace_subscriptions')).rows[0].status,'active');
 await assert.rejects(db.query("select public.record_stockshift_subscription('evt_bad',$1,'cus_B','sub_B','active',now(),false)",[a]),e=>e.code==='42501');
 await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u})]);
 assert.equal((await db.query('select stripe_customer_id from public.billing_accounts')).rows[0].stripe_customer_id,'cus_A');assert.equal((await db.query('select * from public.billing_accounts')).rows.length,1);
 await assert.rejects(db.query("update public.workspace_subscriptions set status='active'"),e=>e.code==='42501');await assert.rejects(db.query("select public.record_stockshift_subscription('evt_forge',$1,'cus_A','sub_A','active',now(),true)",[a]),e=>e.code==='42501');
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:v})]);assert.equal((await db.query('select * from public.workspace_subscriptions')).rows.length,0);
 }finally{await db.close();}
});
