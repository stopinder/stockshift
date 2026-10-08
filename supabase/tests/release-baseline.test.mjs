// Complete reconciled schema; native mode is fixed-loopback and fully rolled back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("reconciled baseline charges comparisons only and preserves bounded PDF preparation", async () => {
  const native = process.env.STOCKSHIFT_TEST_LOCAL_POSTGRES === "1";
  let db;
  const dir = new URL("../migrations/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
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
    db = {
      query: (sql, args) => client.query(sql, args),
      exec: (sql) => client.query(sql),
      close: () => client.end(),
    };
  } else {
    db = new PGlite();
    await db.exec(
      await readFile(new URL("bootstrap.sql", import.meta.url), "utf8"),
    );
    // Embedded Postgres lacks Supabase's pgcrypto extension schema. Use its real
    // built-in SHA-256 for the direct-extraction configuration digest, not a stub.
    await db.exec(
      "create schema extensions; create function extensions.digest(value text, algorithm text) returns bytea language sql immutable as $$ select case when algorithm='sha256' then sha256(convert_to(value,'UTF8')) else null end $$;",
    );
  }
  try {
    await db.exec("begin");
    const applied = native
      ? new Set(
          (
            await db.query(
              "select version from supabase_migrations.schema_migrations",
            )
          ).rows.map((r) => r.version),
        )
      : new Set();
    for (const f of files) {
      if (applied.has(f.split("_")[0])) continue;
      // Published migrations may wrap their own transaction. This test owns it.
      const sql = (await readFile(new URL(f, dir), "utf8")).replace(
        /^\s*(?:begin|commit);\s*$/gim,
        "",
      );
      await db.exec(sql);
    }
    const owner = randomUUID(),
      other = randomUUID();
    await db.query(
      "insert into auth.users(id,email_confirmed_at,is_anonymous) values($1,now(),false),($2,now(),false)",
      [owner, other],
    );
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: owner }),
    ]);
    const tenant = (
      await db.query(
        "select public.create_customer_workspace('Chunk 11 bounded customer') id",
      )
    ).rows[0].id;
    const status = async () =>
      (
        await db.query("select public.workspace_allowance_status($1) value", [
          tenant,
        ])
      ).rows[0].value;
    assert.equal((await status()).comparisons_remaining, 3);
    const upload = async (name, mime) => {
      const f = (
        await db.query("select public.create_upload_intent($1,$2,10) value", [
          tenant,
          name,
        ])
      ).rows[0].value;
      await db.exec("reset role");
      await db.query(
        "insert into storage.objects(bucket_id,name,owner_id,metadata) values('catalogue-uploads',$1,$2,$3)",
        [f.object_name, owner, { size: 10 }],
      );
      await db.exec("set role service_role");
      const lease = (
        await db.query(
          "select public.transition_catalogue_upload($1,$2,$3,'begin',null,null,null,null::uuid) value",
          [tenant, f.id, owner],
        )
      ).rows[0].value.verification_lease;
      await db.query(
        "select public.transition_catalogue_upload($1,$2,$3,'finish',10,$4,$5,$6::uuid)",
        [tenant, f.id, owner, mime, "a".repeat(64), lease],
      );
      await db.exec("set role authenticated");
      return f;
    };
    const a = await upload("old.csv", "text/csv"),
      b = await upload("new.csv", "text/csv");
    const comparison = (
      await db.query(
        "insert into public.comparisons(tenant_id,title) values($1,'CSV') returning id",
        [tenant],
      )
    ).rows[0].id;
    for (const [file, side] of [
      [a, "current"],
      [b, "incoming"],
    ])
      await db.query(
        "insert into public.comparison_files(tenant_id,comparison_id,source_file_id,side) values($1,$2,$3,$4)",
        [tenant, comparison, file.id, side],
      );
    const options = {
      encoding: "utf-8-sig",
      delimiter: ",",
      decimal_separator: ".",
      columns: { supplier_sku: "SKU", cost_price: "Price" },
    };
    const key = randomUUID();
    const queue = async () =>
      (
        await db.query(
          "select public.enqueue_comparison_job($1,$2,$3,$4,$4,3) value",
          [tenant, comparison, key, options],
        )
      ).rows[0].value;
    const first = await queue();
    assert.equal((await status()).comparisons_remaining, 2);
    assert.equal((await queue()).id, first.id);
    assert.equal((await status()).comparisons_remaining, 2);
    const pdf = await upload("digital.pdf", "application/pdf");
    const inspect = async () =>
      (
        await db.query("select public.enqueue_pdf_inspection($1,$2) value", [
          tenant,
          pdf.id,
        ])
      ).rows[0].value;
    const inspected = await inspect();
    assert.equal(inspected.job.kind, "inspect_pdf");
    assert.equal((await status()).comparisons_remaining, 2);
    assert.equal((await inspect()).job.id, inspected.job.id);
    assert.equal((await status()).comparisons_remaining, 2);
    const cfg = { first_page: 1, last_page: 1, strategy: "lines" };
    await db.query("select public.enqueue_pdf_extraction($1,$2,$3)", [
      tenant,
      pdf.id,
      cfg,
    ]);
    assert.equal((await status()).comparisons_remaining, 2);
    await db.query("select public.enqueue_pdf_extraction($1,$2,$3)", [
      tenant,
      pdf.id,
      cfg,
    ]);
    assert.equal((await status()).comparisons_remaining, 2);
    for (let i = 0; i < 2; i++)
      await db.query("select public.enqueue_comparison_job($1,$2,$3,$4,$4,3)", [
        tenant,
        comparison,
        randomUUID(),
        options,
      ]);
    assert.equal((await status()).comparisons_remaining, 0);
    assert.equal((await queue()).id, first.id);
    await db.query("select public.enqueue_pdf_extraction($1,$2,$3)", [
      tenant,
      pdf.id,
      { ...cfg, strategy: "text" },
    ]);
    assert.equal((await status()).comparisons_remaining, 0);
    await db.exec("savepoint exhausted");
    await assert.rejects(
      db.query("select public.enqueue_comparison_job($1,$2,$3,$4,$4,3)", [
        tenant,
        comparison,
        randomUUID(),
        options,
      ]),
      (e) =>
        e.code === "P0001" &&
        e.message === "Trial comparison allowance reached",
    );
    await db.exec("rollback to exhausted; release exhausted");
    // Local-only subscription fixture: the same job filter must also preserve
    // the existing paid counter/period policy, without changing billing code.
    await db.exec("reset role");
    await db.query(
      "insert into public.billing_accounts(tenant_id,stripe_customer_id) values($1,$2)",
      [tenant, "cus_" + randomUUID().replaceAll("-", "")],
    );
    await db.query(
      "insert into public.workspace_subscriptions(tenant_id,stripe_subscription_id,status,period_start,period_end,livemode) values($1,$2,'active',now()-interval '1 hour',now()+interval '1 month',true)",
      [tenant, "sub_" + randomUUID().replaceAll("-", "")],
    );
    await db.exec("set role authenticated");
    await db.query("select public.enqueue_pdf_extraction($1,$2,$3)", [
      tenant,
      pdf.id,
      { ...cfg, last_page: 2 },
    ]);
    assert.equal((await status()).comparisons_remaining, 20);
    await db.query("select public.enqueue_comparison_job($1,$2,$3,$4,$4,3)", [
      tenant,
      comparison,
      randomUUID(),
      options,
    ]);
    assert.equal((await status()).comparisons_remaining, 19);
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({ sub: other }),
    ]);
    await db.exec("savepoint unauthorized");
    await assert.rejects(
      db.query("select public.enqueue_pdf_inspection($1,$2)", [tenant, pdf.id]),
      (e) => e.code === "42501",
    );
    await db.exec("rollback to unauthorized; release unauthorized");
    await db.exec("reset role");
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from private.ocr_pages where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.correction_revisions where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await db.exec("rollback");
    await db.close();
  }
});
