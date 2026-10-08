import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const migration = new URL('../migrations/20261007132615_customer_workspace_onboarding.sql', import.meta.url);
async function setup() {
 const db = new PGlite();
 await db.exec(await readFile(new URL('bootstrap.sql', import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../migrations/20261005141354_tenant_upload_foundations.sql', import.meta.url),'utf8'));
 await db.exec(await readFile(migration,'utf8'));
 const users=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'];
 await db.query("insert into auth.users(id,email_confirmed_at,is_anonymous) values ($1,now(),false),($2,now(),false),($3,null,false),($4,now(),true)",users);
 return { db,users };
}
async function as(db,user,role='authenticated') { await db.exec(`set role ${role}`); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,user_metadata:{role:'owner'}})]); }
test('confirmed customer gets one isolated owner workspace and repeat calls reuse it', async()=>{
 const {db,users}=await setup();try {
 await as(db,users[0]); const first=(await db.query("select public.create_customer_workspace(' First business ') id")).rows[0].id;
 const again=(await db.query("select public.create_customer_workspace('Duplicate') id")).rows[0].id;assert.equal(first,again);
 let rows=(await db.query('select name from public.tenants')).rows;assert.deepEqual(rows,[{name:'First business'}]);
 assert.equal((await db.query('select role from public.tenant_memberships')).rows[0].role,'owner');
 await as(db,users[1]);assert.equal((await db.query('select * from public.tenants')).rows.length,0);
 const second=(await db.query("select public.create_customer_workspace('Second business') id")).rows[0].id;assert.notEqual(second,first);
 assert.deepEqual((await db.query('select name from public.tenants')).rows,[{name:'Second business'}]);
 }finally{await db.close();}
});
test('anonymous, unconfirmed and unauthenticated callers cannot create workspaces',async()=>{
 const {db,users}=await setup();try {
 for(const u of [users[2],users[3],null]) {await as(db,u);await assert.rejects(db.query("select public.create_customer_workspace('Invalid')"),e=>e.code==='42501');}
 await as(db,null,'anon');await assert.rejects(db.query("select public.create_customer_workspace('Invalid')"),e=>e.code==='42501');
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from public.tenants')).rows[0].n,0);
 }finally{await db.close();}
});
test('invalid names are rejected and invited viewers cannot bootstrap an owner workspace',async()=>{
 const {db,users}=await setup();try {
 await as(db,users[0]);for(const name of [null,' ', 'x'.repeat(201)])await assert.rejects(db.query('select public.create_customer_workspace($1)',[name]),e=>e.code==='22023');
 const id=(await db.query("select public.create_customer_workspace('Shared') id")).rows[0].id;
 await db.exec('reset role');await db.query("insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'viewer')",[id,users[1]]);
 await as(db,users[1]);assert.equal((await db.query("select public.create_customer_workspace('Escalation') id")).rows[0].id,id);
 assert.equal((await db.query('select role from public.tenant_memberships where user_id=$1',[users[1]])).rows[0].role,'viewer');
 }finally{await db.close();}
});
