import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("allowance projection is member-scoped, read-only, and mirrors effective quota periods", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      await readFile(new URL("bootstrap.sql", import.meta.url), "utf8"),
    );
    const dir = new URL("../migrations/", import.meta.url);
    for (const f of (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(f, dir), "utf8"));
    const owner = "11111111-1111-4111-8111-111111111111",
      viewer = "22222222-2222-4222-8222-222222222222",
      outsider = "33333333-3333-4333-8333-333333333333";
    for (const id of [owner, viewer, outsider])
      await db.query(
        "insert into auth.users(id,email_confirmed_at) values($1,now())",
        [id],
      );
    const tenant = (
      await db.query(
        "insert into public.tenants(name) values('Allowance test') returning id",
      )
    ).rows[0].id;
    for (const [user, role] of [
      [owner, "owner"],
      [viewer, "viewer"],
    ])
      await db.query(
        "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,$3)",
        [tenant, user, role],
      );
    const status = async (user = owner) => {
      await db.query("select set_config('request.jwt.claims',$1,false)", [
        JSON.stringify({ sub: user }),
      ]);
      await db.exec("set role authenticated");
      try {
        return (
          await db.query(
            "select public.workspace_allowance_status($1) as status",
            [tenant],
          )
        ).rows[0].status;
      } finally {
        await db.exec("reset role");
      }
    };
    assert.deepEqual(await status(), {
      plan: "trial",
      comparisons_remaining: 3,
      comparison_limit: 3,
      uploads_remaining: 20,
      upload_limit: 20,
      bytes_remaining: 104857600,
      byte_limit: 104857600,
      period_end: null,
    });
    assert.deepEqual(await status(viewer), await status(owner));
    await assert.rejects(status(outsider), (e) => e.code === "42501");
    await db.exec("set role anon");
    await assert.rejects(
      db.query("select public.workspace_allowance_status($1)", [tenant]),
      (e) => e.code === "42501",
    );
    await db.exec("reset role");
    await db.query(
      "update public.workspace_allowances set trial_remaining=0,reserved_files=20,reserved_bytes=104857600 where tenant_id=$1",
      [tenant],
    );
    assert.equal((await status()).comparisons_remaining, 0);
    assert.equal((await status()).uploads_remaining, 0);
    await db.query(
      "insert into public.billing_accounts(tenant_id,stripe_customer_id) values($1,'cus_Allowance')",
      [tenant],
    );
    await db.query(
      "insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_start,period_end,livemode) values($1,'sub_Allowance','active',now()-interval '1 hour',now()+interval '1 month',false)",
      [tenant],
    );
    assert.equal((await status()).plan, "trial");
    await db.query(
      "update public.workspace_subscriptions set livemode=true where tenant_id=$1",
      [tenant],
    );
    assert.equal((await status(viewer)).comparisons_remaining, 20);
    assert.equal((await status(viewer)).uploads_remaining, 180);
    await db.query(
      "update public.workspace_allowances set paid_period_start=(select period_start from public.workspace_subscriptions where tenant_id=$1),paid_used=19 where tenant_id=$1",
      [tenant],
    );
    assert.equal((await status()).comparisons_remaining, 1);
    await db.query(
      "update public.workspace_subscriptions set period_start=now()-interval '1 minute' where tenant_id=$1",
      [tenant],
    );
    assert.equal((await status()).comparisons_remaining, 20);
    assert.equal(
      (
        await db.query(
          "select paid_used from public.workspace_allowances where tenant_id=$1",
          [tenant],
        )
      ).rows[0].paid_used,
      19,
    ); // reading never resets a counter
    for (const condition of [
      "status='past_due'",
      "status='active',period_end=now()-interval '1 second'",
      "period_start=now()+interval '1 day',period_end=now()+interval '1 month'",
    ]) {
      await db.query(
        `update public.workspace_subscriptions set ${condition} where tenant_id=$1`,
        [tenant],
      );
      assert.equal((await status()).plan, "trial");
    }
    await db.query(
      "update public.workspace_allowances set pilot_exempt=true where tenant_id=$1",
      [tenant],
    );
    const pilot = await status();
    assert.equal(pilot.plan, "pilot");
    assert.equal(pilot.comparisons_remaining, null);
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: viewer }),
    ]);
    await db.exec("set role authenticated");
    assert.equal(
      (await db.query("select * from public.workspace_subscriptions")).rows
        .length,
      0,
    );
    await assert.rejects(
      db.exec("update public.workspace_allowances set trial_remaining=3"),
      (e) => e.code === "42501",
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});
