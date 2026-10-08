// Native local connections exercise committed, competing enqueue requests.
// Fixtures are additive; existing workspaces and data are never reset/deleted.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "pg";

const connection = {
  host: "127.0.0.1",
  port: 54322,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  ssl: false,
};
const options = {
  encoding: "utf-8-sig",
  delimiter: ",",
  decimal_separator: ".",
  columns: { supplier_sku: "SKU", cost_price: "Price" },
};
test("native trial comparison charging is atomic under duplicate/concurrent enqueue and fenced retries", async () => {
  const db = new Client(connection);
  await db.connect();
  const owner = randomUUID(),
    tenant = randomUUID(),
    comparison = randomUUID(),
    worker = randomUUID();
  const rpc = async (client, name, args) =>
    (
      await client.query(
        `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`,
        args.map((value) =>
          Array.isArray(value) ? JSON.stringify(value) : value,
        ),
      )
    ).rows[0].value;
  const remaining = async () =>
    (
      await db.query(
        "select trial_remaining from public.workspace_allowances where tenant_id=$1",
        [tenant],
      )
    ).rows[0].trial_remaining;
  const enqueue = async (key, target = comparison) => {
    const client = new Client(connection);
    await client.connect();
    try {
      await client.query("set role authenticated");
      await client.query("select set_config('request.jwt.claims',$1,false)", [
        JSON.stringify({ sub: owner }),
      ]);
      return await rpc(client, "enqueue_comparison_job", [
        tenant,
        target,
        key,
        options,
        options,
        3,
      ]);
    } finally {
      await client.end();
    }
  };
  try {
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.jobs where status in ('queued','running','retry_wait')",
        )
      ).rows[0].n,
      0,
      "Do not claim unrelated pending jobs",
    );
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query(
      "insert into public.tenants(id,name) values($1,'Chunk 12 concurrent trial')",
      [tenant],
    );
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
      [tenant, owner],
    );
    const files = [randomUUID(), randomUUID()];
    for (const file of files)
      await db.query(
        "insert into public.source_files(id,tenant_id,created_by,original_filename,expected_byte_count,status,byte_count,verified_mime,sha256,finalized_at) values($1,$2,$3,'quota.csv',10,'ready',10,'text/csv',$4,now())",
        [file, tenant, owner, "a".repeat(64)],
      );
    const comparisons = [
      comparison,
      ...Array.from({ length: 7 }, () => randomUUID()),
    ];
    for (const target of comparisons) {
      await db.query(
        "insert into public.comparisons(id,tenant_id,title,created_by) values($1,$2,'Concurrent quota',$3)",
        [target, tenant, owner],
      );
      for (const [i, side] of ["current", "incoming"].entries())
        await db.query(
          "insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values($1,$2,$3,$4)",
          [tenant, target, files[i], side],
        );
    }
    const key = randomUUID();
    const duplicated = await Promise.all(
      Array.from({ length: 8 }, () => enqueue(key)),
    );
    assert.equal(new Set(duplicated.map((j) => j.id)).size, 1);
    assert.equal(await remaining(), 2);
    const competed = await Promise.allSettled(
      comparisons.map((target) => enqueue(randomUUID(), target)),
    );
    assert.equal(competed.filter((r) => r.status === "fulfilled").length, 2);
    for (const r of competed.filter((r) => r.status === "rejected")) {
      assert.equal(r.reason.code, "P0001");
      assert.equal(r.reason.message, "Trial comparison allowance reached");
    }
    assert.equal(await remaining(), 0);
    assert.equal((await enqueue(key)).id, duplicated[0].id);
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.comparison_runs where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
      3,
      "Rejected inserts roll back their run as well",
    );
    await db.query("set role service_role");
    const job = await rpc(db, "claim_csv_job", [worker]);
    assert.equal(job.tenant_id, tenant);
    await rpc(db, "fail_csv_job", [
      tenant,
      job.id,
      worker,
      job.lease_token,
      {
        code: "storage_unavailable",
        stage: "load",
        message: "Test retry",
        retryable: true,
      },
      true,
    ]);
    await db.query("reset role");
    await db.query(
      "update public.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",
      [job.id],
    );
    await db.query("set role service_role");
    for (let i = 0; i < 3; i++) {
      const claimed = await rpc(db, "claim_csv_job", [worker]);
      assert.equal(claimed.tenant_id, tenant);
      if (claimed.id === job.id) {
        assert.equal(claimed.attempt_count, 2);
        assert.notEqual(claimed.lease_token, job.lease_token);
        await assert.rejects(
          rpc(db, "complete_csv_job", [
            tenant,
            job.id,
            worker,
            job.lease_token,
            [],
          ]),
          (e) => e.code === "42501",
        );
      }
      await rpc(db, "complete_csv_job", [
        tenant,
        claimed.id,
        worker,
        claimed.lease_token,
        [],
      ]);
    }
    await db.query("reset role");
    assert.equal(await remaining(), 0);
    assert.equal((await enqueue(key)).id, duplicated[0].id);
    await assert.rejects(enqueue(randomUUID()), (e) => e.code === "P0001");
    assert.equal(
      (
        await db.query(
          "select reserved_files,reserved_bytes from public.workspace_allowances where tenant_id=$1",
          [tenant],
        )
      ).rows[0].reserved_files,
      2,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.jobs where tenant_id=$1 and status='succeeded'",
          [tenant],
        )
      ).rows[0].n,
      3,
    );
  } finally {
    await db.end();
  }
});
