import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
async function setup() {
  const native = process.env.STOCKSHIFT_TEST_LOCAL_POSTGRES === "1";
  let db;
  let applied = new Set();
  if (native) {
    const { Client } = await import("pg");
    const client = new Client({
      host: "127.0.0.1",
      port: 54322,
      database: "postgres",
      user: "postgres",
      password: "postgres",
      ssl: false,
    });
    await client.connect();
    await client.query("begin");
    applied = new Set(
      (
        await client.query(
          "select version from supabase_migrations.schema_migrations",
        )
      ).rows.map((r) => r.version),
    );
    db = {
      exec: (sql) => client.query(sql),
      // Expected authorization failures must not abort the enclosing preservation transaction.
      query: async (sql, args) => {
        await client.query("savepoint assertion");
        try {
          const result = await client.query(sql, args);
          await client.query("release savepoint assertion");
          return result;
        } catch (error) {
          await client.query("rollback to savepoint assertion");
          await client.query("release savepoint assertion");
          throw error;
        }
      },
      close: async () => {
        try {
          await client.query("rollback");
        } finally {
          await client.end();
        }
      },
    };
  } else {
    db = new PGlite();
    await db.exec(
      await readFile(new URL("bootstrap.sql", import.meta.url), "utf8"),
    );
  }
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (applied.has(f.split("_")[0])) continue;
    const sql = await readFile(new URL(f, dir), "utf8");
    await db.exec(
      native ? sql.replace(/^\s*(?:begin|commit);\s*$/gim, "") : sql,
    );
  }
  const owner = randomUUID(),
    other = randomUUID(),
    unconfirmed = randomUUID();
  await db.query(
    "insert into auth.users(id,email_confirmed_at) values($1,now()),($2,now()),($3,null)",
    [owner, other, unconfirmed],
  );
  return { db, owner, other, unconfirmed };
}
async function as(db, user, role = "authenticated") {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user }),
  ]);
}
async function create(db, name, request, test = false) {
  return (
    await db.query("select public.create_business_workspace($1,$2,$3) result", [
      name,
      request,
      test,
    ])
  ).rows[0].result;
}
const reqs = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
];
test("one account gets one trial; additional and test workspaces have no free quota; retries and caps are enforced", async () => {
  const { db, owner, other } = await setup();
  try {
    await as(db, owner);
    const first = await create(db, " First ", reqs[0]);
    assert.equal(first.subscription_required, false);
    assert.deepEqual(await create(db, "Retry", reqs[0]), first);
    const second = await create(db, "Second", reqs[1]);
    assert.equal(second.subscription_required, true);
    const third = await create(db, "Stripe test", reqs[2], true);
    assert.equal(third.test_workspace, true);
    assert.equal(third.subscription_required, true);
    assert.deepEqual(await create(db, "Retry at cap", reqs[2], true), third);
    await assert.rejects(
      create(db, "Fourth", reqs[3]),
      (e) => e.code === "P0001",
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.tenant_memberships where user_id=$1 and role='owner'",
          [owner],
        )
      ).rows[0].n,
      3,
    );
    const status = (
      await db.query("select public.workspace_creation_status() s")
    ).rows[0].s;
    assert.deepEqual(status, {
      owned_count: 3,
      workspace_limit: 3,
      trial_available: false,
    });
    const quota = (
      await db.query("select public.workspace_allowance_status($1) s", [
        second.tenant_id,
      ])
    ).rows[0].s;
    assert.equal(quota.plan, "subscription_required");
    assert.equal(quota.comparisons_remaining, 0);
    assert.equal(quota.uploads_remaining, 0);
    await assert.rejects(
      db.query("select * from private.workspace_trial_claims"),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query(
        "update public.workspace_allowances set trial_remaining=3 where tenant_id=$1",
        [second.tenant_id],
      ),
      (e) => e.code === "42501",
    );
    await as(db, other);
    assert.equal(
      (
        await db.query("select * from public.tenants where id=$1", [
          first.tenant_id,
        ])
      ).rows.length,
      0,
    );
    const own = await create(db, "Other customer", reqs[0]);
    assert.notEqual(own.tenant_id, first.tenant_id);
    assert.equal(own.subscription_required, false);
  } finally {
    await db.close();
  }
});
test("test workspace does not claim the first business trial and legacy onboarding cannot bypass the ledger", async () => {
  const { db, owner } = await setup();
  try {
    await as(db, owner);
    await create(db, "Test first", reqs[0], true);
    assert.equal(
      (await db.query("select public.workspace_creation_status() s")).rows[0].s
        .trial_available,
      true,
    );
    const business = await create(db, "First business", reqs[1]);
    assert.equal(business.subscription_required, false);
    await db.exec("reset role");
    await db.query("delete from public.tenant_memberships where user_id=$1", [
      owner,
    ]);
    await as(db, owner);
    const legacy = (
      await db.query(
        "select public.create_customer_workspace('After membership removal') id",
      )
    ).rows[0].id;
    assert.equal(
      (
        await db.query("select public.workspace_allowance_status($1) s", [
          legacy,
        ])
      ).rows[0].s.plan,
      "subscription_required",
    );
  } finally {
    await db.close();
  }
});
test("unconfirmed and anonymous users cannot create; invited viewers never elevate another business role", async () => {
  const { db, owner, other, unconfirmed } = await setup();
  try {
    await as(db, unconfirmed);
    await assert.rejects(
      create(db, "Denied", reqs[0]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.workspace_creation_status()"),
      (e) => e.code === "42501",
    );
    await as(db, null, "anon");
    await assert.rejects(
      create(db, "Denied", reqs[0]),
      (e) => e.code === "42501",
    );
    await as(db, owner);
    const first = await create(db, "Owner business", reqs[0]);
    await db.exec("reset role");
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'viewer')",
      [first.tenant_id, other],
    );
    await as(db, other);
    const own = await create(db, "Own business", reqs[0]);
    assert.notEqual(own.tenant_id, first.tenant_id);
    assert.equal(
      (
        await db.query(
          "select role from public.tenant_memberships where tenant_id=$1 and user_id=$2",
          [first.tenant_id, other],
        )
      ).rows[0].role,
      "viewer",
    );
  } finally {
    await db.close();
  }
});
test("only an active live subscription unlocks an additional business; test-only workspaces remain locked", async () => {
  const { db, owner } = await setup();
  try {
    await as(db, owner);
    await create(db, "Trial", reqs[0]);
    const second = await create(db, "Paid required", reqs[1]);
    const third = await create(db, "Test", reqs[2], true);
    await db.exec("reset role");
    for (const [tenant, customer, sub] of [
      [second.tenant_id, "cus_Second", "sub_Second"],
      [third.tenant_id, "cus_Test", "sub_Test"],
    ]) {
      await db.query(
        "insert into public.billing_accounts(tenant_id,stripe_customer_id) values($1,$2)",
        [tenant, customer],
      );
      await db.query(
        "insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_start,period_end,livemode) values($1,$2,'active',now()-interval '1 hour',now()+interval '1 month',false)",
        [tenant, sub],
      );
    }
    await as(db, owner);
    assert.equal(
      (
        await db.query("select public.workspace_allowance_status($1) s", [
          second.tenant_id,
        ])
      ).rows[0].s.plan,
      "subscription_required",
    );
    await db.exec("reset role");
    await db.exec(
      "create table public.subscription_gate_probe(tenant_id uuid)",
    );
    await db.exec(
      "create trigger guard before insert on public.subscription_gate_probe for each row execute function private.require_workspace_subscription()",
    );
    await assert.rejects(
      db.query("insert into public.subscription_gate_probe values($1)", [
        second.tenant_id,
      ]),
      (e) => e.code === "P0001",
    );
    await db.query(
      "update public.workspace_subscriptions set livemode=true where tenant_id=$1",
      [second.tenant_id],
    );
    await db.query("insert into public.subscription_gate_probe values($1)", [
      second.tenant_id,
    ]);
    await as(db, owner);
    assert.equal(
      (
        await db.query("select public.workspace_allowance_status($1) s", [
          second.tenant_id,
        ])
      ).rows[0].s.plan,
      "paid",
    );
    await db.exec("reset role");
    await db.query(
      "update public.workspace_subscriptions set livemode=true where tenant_id=$1",
      [third.tenant_id],
    );
    await assert.rejects(
      db.query("insert into public.subscription_gate_probe values($1)", [
        third.tenant_id,
      ]),
      (e) => e.code === "P0001",
    );
    await db.query(
      "update public.workspace_subscriptions set status='past_due' where tenant_id=$1",
      [second.tenant_id],
    );
    await assert.rejects(
      db.query("insert into public.subscription_gate_probe values($1)", [
        second.tenant_id,
      ]),
      (e) => e.code === "P0001",
    );
  } finally {
    await db.close();
  }
});

test("subscription gates reject real upload reservations and every CPU job kind before quota or linkage changes", async () => {
  const { db, owner, other } = await setup();
  try {
    await as(db, owner);
    await create(db, "First business", reqs[0]);
    const locked = await create(db, "Additional business", reqs[1]);
    await assert.rejects(
      db.query("select public.create_upload_intent($1,'digital.pdf',10)", [
        locked.tenant_id,
      ]),
      (e) => e.code === "P0001" && /own active subscription/.test(e.message),
    );
    await db.exec("reset role");
    // Trigger rejection precedes FK validation even for privileged inserts.
    // Preparation kinds are covered by the same database subscription gate.
    for (const kind of ["inspect_pdf", "extract_pdf", "reconcile_csv"]) {
      await assert.rejects(
        db.query(
          "insert into public.jobs(tenant_id,kind,idempotency_key) values($1,$2,$3)",
          [locked.tenant_id, kind, randomUUID()],
        ),
        (e) => e.code === "P0001" && /own active subscription/.test(e.message),
      );
    }
    const counters = (
      await db.query(
        "select trial_remaining,reserved_files,reserved_bytes,paid_used from public.workspace_allowances where tenant_id=$1",
        [locked.tenant_id],
      )
    ).rows[0];
    assert.equal(counters.trial_remaining, 0);
    assert.equal(counters.reserved_files, 0);
    assert.equal(Number(counters.reserved_bytes), 0);
    assert.equal(counters.paid_used, 0);
    await as(db, other);
    await assert.rejects(
      db.query("select public.workspace_allowance_status($1)", [
        locked.tenant_id,
      ]),
      (e) => e.code === "42501",
    );
    await assert.rejects(
      db.query("select public.create_upload_intent($1,'digital.pdf',10)", [
        locked.tenant_id,
      ]),
      (e) => e.code === "42501",
    );
  } finally {
    await db.close();
  }
});
