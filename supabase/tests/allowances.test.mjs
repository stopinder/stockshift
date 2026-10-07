import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("new-customer quotas bind to accepted resources, preserve pilot access and reset only on a valid live billing period", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(new URL("bootstrap.sql", import.meta.url), "utf8"),
    );
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of migrations.filter(
      (f) =>
        f <
        migrations.find((name) => name.includes("customer_usage_allowances")),
    ))
      await db.exec(await readFile(new URL(f, directory), "utf8"));
    const u = "11111111-1111-4111-8111-111111111111";
    await db.query(
      "insert into auth.users(id,email_confirmed_at) values($1,now())",
      [u],
    );
    const pilot = (
      await db.query(
        "insert into public.tenants(name) values('Pilot') returning id",
      )
    ).rows[0].id;
    await db.exec(
      await readFile(
        new URL(
          migrations.find((f) => f.includes("customer_usage_allowances")),
          directory,
        ),
        "utf8",
      ),
    );
    assert.equal(
      (
        await db.query(
          "select pilot_exempt from public.workspace_allowances where tenant_id=$1",
          [pilot],
        )
      ).rows[0].pilot_exempt,
      true,
    );
    const tenant = (
      await db.query(
        "insert into public.tenants(name) values('Customer') returning id",
      )
    ).rows[0].id;
    const file = async (bytes) =>
      (
        await db.query(
          "insert into public.source_files(tenant_id,original_filename,expected_byte_count,created_by) values($1,'catalogue.csv',$2,$3) returning id",
          [tenant, bytes, u],
        )
      ).rows[0].id;
    const a = await file(1),
      b = await file(1);
    const comparison = (
      await db.query(
        "insert into public.comparisons(tenant_id,title,created_by) values($1,'Test',$2) returning id",
        [tenant, u],
      )
    ).rows[0].id;
    const queue = async (key) => {
      const run = (
        await db.query(
          "insert into public.comparison_runs(tenant_id,comparison_id,current_file_id,incoming_file_id,configuration) values($1,$2,$3,$4,'{}') returning id",
          [tenant, comparison, a, b],
        )
      ).rows[0].id;
      return (
        await db.query(
          "insert into public.jobs(tenant_id,comparison_run_id,idempotency_key) values($1,$2,$3) on conflict(tenant_id,idempotency_key) do nothing returning id",
          [tenant, run, key],
        )
      ).rows[0]?.id;
    };
    const first = await queue("one");
    await queue("one");
    await queue("two");
    await queue("three");
    assert.equal(
      (
        await db.query(
          "select trial_remaining from public.workspace_allowances where tenant_id=$1",
          [tenant],
        )
      ).rows[0].trial_remaining,
      0,
    );
    await db.query("update public.jobs set available_at=now() where id=$1", [
      first,
    ]);
    await assert.rejects(
      queue("four"),
      (e) => e.message === "Trial comparison allowance reached",
    );
    await db.query(
      "insert into public.billing_accounts(tenant_id,stripe_customer_id) values($1,'cus_Customer')",
      [tenant],
    );
    await db.query(
      "insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_start,period_end,livemode) values($1,'sub_Customer','active',now()-interval '1 hour',now()+interval '1 month',false)",
      [tenant],
    );
    await assert.rejects(
      queue("testmode"),
      (e) => e.message === "Trial comparison allowance reached",
    );
    await db.query(
      "update public.workspace_subscriptions set livemode=true where tenant_id=$1",
      [tenant],
    );
    for (let i = 0; i < 20; i++) await queue("paid" + i);
    await assert.rejects(
      queue("paid-over"),
      (e) => e.message === "Monthly comparison allowance reached",
    );
    await db.query(
      "update public.workspace_subscriptions set period_start=now()-interval '1 minute',period_end=now()+interval '1 month' where tenant_id=$1",
      [tenant],
    );
    await queue("renewed");
    assert.equal(
      (
        await db.query(
          "select paid_used from public.workspace_allowances where tenant_id=$1",
          [tenant],
        )
      ).rows[0].paid_used,
      1,
    );
    await db.query(
      "update public.workspace_subscriptions set status='past_due' where tenant_id=$1",
      [tenant],
    );
    await assert.rejects(
      queue("delinquent"),
      (e) => e.message === "Trial comparison allowance reached",
    );
    for (let i = 0; i < 9; i++) await file(10485760);
    await assert.rejects(
      file(10485760),
      (e) => e.message === "Workspace upload allowance reached",
    );
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: u }),
    ]);
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("update public.workspace_allowances set trial_remaining=3"),
      (e) => e.code === "42501",
    );
  } finally {
    await db.close();
  }
});
