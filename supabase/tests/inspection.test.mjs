// Offline PostgreSQL migration/RLS/queue tests; optional fixed-loopback native mode.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const native = process.env.STOCKSHIFT_TEST_LOCAL_POSTGRES === "1";
const db = native
  ? await (async () => {
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
      return {
        exec: (sql) => client.query(sql),
        query: (sql, args) => client.query(sql, args),
        close: () => client.end(),
      };
    })()
  : new PGlite();
const A = randomUUID(),
  B = randomUUID(),
  owner = randomUUID(),
  editor = randomUUID(),
  viewer = randomUUID(),
  other = randomUUID(),
  source = randomUUID(),
  foreign = randomUUID(),
  pending = randomUUID(),
  csv = randomUUID(),
  worker = randomUUID();
async function role(user, which = "authenticated") {
  await db.exec(`set role ${which}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user }),
  ]);
}
async function rpc(name, args = []) {
  return (
    await db.query(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`,
      args,
    )
  ).rows[0].value;
}
async function enqueue() {
  await role(owner);
  return rpc("enqueue_pdf_inspection", [A, source]);
}
async function claim() {
  await role(null, "service_role");
  return rpc("claim_csv_job", [worker]);
}
const lease = (j) => [j.tenant_id, j.id, worker, j.lease_token];
const result = (state = "inspected") => ({
  version: "cpu-inspection-v1",
  page_count: 1,
  state,
  diagnostics: [
    {
      page: 1,
      state: state === "inspected" ? "digital_candidate" : "ocr_required",
      code:
        state === "inspected"
          ? "ruled_table_candidate"
          : "no_usable_embedded_table",
      table_count: state === "inspected" ? 1 : 0,
    },
  ],
});
async function denied(sql, args = [], code = "42501") {
  await db.exec("savepoint rejection");
  try {
    await assert.rejects(db.query(sql, args), (e) => e.code === code);
  } finally {
    await db.exec("rollback to rejection; release savepoint rejection");
  }
}
function check(name, fn) {
  test(name, async () => {
    await db.exec("savepoint test_case");
    try {
      await fn();
    } finally {
      await db.exec(
        "rollback to test_case; release savepoint test_case; reset role",
      );
    }
  });
}
before(async () => {
  if (!native) {
    await db.exec(
      await readFile(new URL("bootstrap.sql", import.meta.url), "utf8"),
    );
    const migrations = new URL("../migrations/", import.meta.url);
    for (const file of (await readdir(migrations))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
  }
  await db.exec("begin");
  for (const user of [owner, editor, viewer, other])
    await db.query("insert into auth.users(id) values($1)", [user]);
  await db.query(
    "insert into public.tenants(id,name) values($1,'Inspection A'),($2,'Inspection B')",
    [A, B],
  );
  for (const [tenant, user, which] of [
    [A, owner, "owner"],
    [A, editor, "editor"],
    [A, viewer, "viewer"],
    [B, other, "owner"],
  ])
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,$3)",
      [tenant, user, which],
    );
  for (const [id, tenant, user, name, mime] of [
    [source, A, owner, "test.pdf", "application/pdf"],
    [foreign, B, other, "other.pdf", "application/pdf"],
    [csv, A, owner, "other.csv", "text/csv"],
  ])
    await db.query(
      `insert into public.source_files(id,tenant_id,created_by,original_filename,
      expected_byte_count,status,byte_count,verified_mime,sha256,finalized_at)
      values($1,$2,$3,$4,10,'ready',10,$5,$6,now())`,
      [id, tenant, user, name, mime, "a".repeat(64)],
    );
  await db.query(
    `insert into public.source_files(id,tenant_id,created_by,original_filename,expected_byte_count)
    values($1,$2,$3,'pending.pdf',10)`,
    [pending, A, owner],
  );
});
after(async () => {
  await db.exec("rollback");
  await db.close();
});

check(
  "owner/editor enqueue is idempotent and creates only one inspection job",
  async () => {
    const first = await enqueue();
    await role(editor);
    const second = await rpc("enqueue_pdf_inspection", [A, source]);
    assert.equal(first.inspection.id, second.inspection.id);
    assert.equal(first.job.id, second.job.id);
    assert.equal(first.job.kind, "inspect_pdf");
    assert.equal(first.job.comparison_run_id, null);
    assert.equal(first.job.extraction_run_id, null);
    const counts = (
      await db.query(
        `select (select count(*) from public.comparison_runs where tenant_id=$1) comparisons,
    (select count(*) from public.extraction_runs where tenant_id=$1) extractions,
    (select count(*) from public.correction_revisions where tenant_id=$1) revisions`,
        [A],
      )
    ).rows[0];
    assert.deepEqual(Object.values(counts).map(Number), [0, 0, 0]);
  },
);
check(
  "viewer, outsider, forged metadata and anonymous callers cannot enqueue",
  async () => {
    for (const user of [viewer, other]) {
      await role(user);
      await denied("select public.enqueue_pdf_inspection($1,$2)", [A, source]);
    }
    await role(viewer);
    await db.query("select set_config('request.jwt.claims',$1,false)", [
      JSON.stringify({
        sub: viewer,
        user_metadata: { role: "owner", tenant_id: A },
      }),
    ]);
    await denied("select public.enqueue_pdf_inspection($1,$2)", [A, source]);
    await role(null, "anon");
    await denied("select public.enqueue_pdf_inspection($1,$2)", [A, source]);
  },
);
check(
  "cross-tenant, pending and non-PDF source references are rejected",
  async () => {
    await role(owner);
    for (const id of [foreign, pending, csv])
      await denied("select public.enqueue_pdf_inspection($1,$2)", [A, id]);
  },
);
check(
  "RLS allows tenant viewer reads and hides other tenants; client writes denied",
  async () => {
    const first = await enqueue();
    await role(viewer);
    assert.equal(
      (await db.query("select id from public.pdf_inspections")).rows[0].id,
      first.inspection.id,
    );
    await denied("update public.pdf_inspections set status='inspected'");
    await denied("delete from public.pdf_inspections");
    await denied(
      "insert into public.pdf_inspections(tenant_id,source_file_id) values($1,$2)",
      [A, source],
    );
    await role(other);
    assert.equal(
      (await db.query("select id from public.pdf_inspections")).rows.length,
      0,
    );
    await role(null, "anon");
    await denied("select * from public.pdf_inspections");
  },
);
check(
  "worker RPCs are service-only, with tenant and lease fencing",
  async () => {
    await enqueue();
    const j = await claim();
    await role(owner);
    await denied("select public.load_pdf_inspection($1,$2,$3,$4)", lease(j));
    await denied("select public.complete_pdf_inspection($1,$2,$3,$4,$5)", [
      ...lease(j),
      result(),
    ]);
    await role(null, "service_role");
    assert.equal((await rpc("load_pdf_inspection", lease(j))).file.id, source);
    await denied("select public.load_pdf_inspection($1,$2,$3,$4)", [
      B,
      j.id,
      worker,
      j.lease_token,
    ]);
    await denied("select public.complete_pdf_inspection($1,$2,$3,$4,$5)", [
      ...lease(j).slice(0, 3),
      randomUUID(),
      result(),
    ]);
  },
);
check(
  "completion is atomic, idempotent and immutable; conflicts rejected",
  async () => {
    await enqueue();
    const j = await claim();
    const done = await rpc("complete_pdf_inspection", [...lease(j), result()]);
    assert.equal(done.status, "inspected");
    assert.equal(done.page_count, 1);
    assert.equal(
      (await rpc("complete_pdf_inspection", [...lease(j), result()])).id,
      done.id,
    );
    await denied(
      "select public.complete_pdf_inspection($1,$2,$3,$4,$5)",
      [...lease(j), result("ocr_required")],
      "23514",
    );
    const saved = (
      await db.query("select * from public.jobs where id=$1", [j.id])
    ).rows[0];
    assert.equal(saved.status, "succeeded");
    assert.equal(saved.lease_token, null);
    await db.exec("reset role");
    await denied(
      "update public.pdf_inspections set page_count=2 where id=$1",
      [done.id],
      "23514",
    );
  },
);
check(
  "expired lease cannot load, complete or fail; replacement token can publish",
  async () => {
    await enqueue();
    const stale = await claim();
    await db.exec("reset role");
    await db.query(
      "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [stale.id],
    );
    await role(null, "service_role");
    await denied(
      "select public.load_pdf_inspection($1,$2,$3,$4)",
      lease(stale),
    );
    await denied("select public.complete_pdf_inspection($1,$2,$3,$4,$5)", [
      ...lease(stale),
      result(),
    ]);
    const current = await claim();
    assert.equal(current.id, stale.id);
    assert.notEqual(current.lease_token, stale.lease_token);
    await denied("select public.fail_csv_job($1,$2,$3,$4,$5,$6)", [
      ...lease(stale),
      { code: "stale", stage: "inspect", message: "Stale worker" },
      false,
    ]);
    assert.equal(
      (await rpc("complete_pdf_inspection", [...lease(current), result()]))
        .status,
      "inspected",
    );
  },
);
check(
  "transient failure retries; exhausted expired lease dead-letters inspection",
  async () => {
    await enqueue();
    const j = await claim();
    const failure = {
      code: "transport_unavailable",
      stage: "inspect",
      message: "Transport unavailable",
    };
    assert.equal(
      (await rpc("fail_csv_job", [...lease(j), failure, true])).status,
      "retry_wait",
    );
    assert.equal(
      (
        await db.query(
          "select status from public.pdf_inspections where tenant_id=$1",
          [A],
        )
      ).rows[0].status,
      "queued",
    );
    await db.exec("reset role");
    await db.query(
      "update public.jobs set available_at=clock_timestamp()-interval '1 second',max_attempts=2 where id=$1",
      [j.id],
    );
    const last = await claim();
    await db.exec("reset role");
    await db.query(
      "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [last.id],
    );
    assert.equal(await claim(), null);
    assert.equal(
      (
        await db.query(
          "select status from public.pdf_inspections where tenant_id=$1",
          [A],
        )
      ).rows[0].status,
      "failed",
    );
    assert.equal(
      (await db.query("select status from public.jobs where id=$1", [j.id]))
        .rows[0].status,
      "dead_letter",
    );
  },
);
check(
  "integrity/parser failure stays terminal without publishing diagnostics",
  async () => {
    await enqueue();
    const j = await claim();
    const failure = {
      code: "invalid_pdf_job",
      stage: "inspect",
      message: "PDF integrity verification failed",
    };
    assert.equal(
      (await rpc("fail_csv_job", [...lease(j), failure, false])).status,
      "failed",
    );
    const row = (
      await db.query(
        "select * from public.pdf_inspections where tenant_id=$1",
        [A],
      )
    ).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(row.page_count, null);
    assert.equal(row.diagnostics, null);
  },
);
check(
  "incomplete, oversized, extra-field and inconsistent results are rejected",
  async () => {
    await enqueue();
    const j = await claim();
    for (const invalid of [
      null,
      {},
      { ...result(), page_count: 51 },
      { ...result(), diagnostics: [] },
      { ...result(), records: [] },
      { ...result(), state: "ocr_required" },
      { ...result(), diagnostics: [{ ...result().diagnostics[0], page: 2 }] },
      {
        ...result(),
        diagnostics: [{ ...result().diagnostics[0], code: "x".repeat(33000) }],
      },
    ])
      await denied(
        "select public.complete_pdf_inspection($1,$2,$3,$4,$5)",
        [...lease(j), invalid],
        "23514",
      );
    assert.equal(
      (
        await db.query(
          "select result_digest from public.pdf_inspections where tenant_id=$1",
          [A],
        )
      ).rows[0].result_digest,
      null,
    );
  },
);
check(
  "same-tenant FKs and job-kind linkage prevent mismatched inspection identities",
  async () => {
    const first = await enqueue();
    await db.exec("reset role");
    await denied(
      "insert into public.pdf_inspections(tenant_id,source_file_id,created_by) values($1,$2,$3)",
      [A, foreign, owner],
      "23503",
    );
    await denied(
      "update public.jobs set tenant_id=$1 where id=$2",
      [B, first.job.id],
      "23514",
    );
    const foreignInspection = randomUUID();
    await db.query(
      "insert into public.pdf_inspections(id,tenant_id,source_file_id,created_by) values($1,$2,$3,$4)",
      [foreignInspection, B, foreign, other],
    );
    await denied(
      "update public.jobs set inspection_run_id=$1 where id=$2",
      [foreignInspection, first.job.id],
      "23503",
    );
    await denied(
      "update public.jobs set kind='reconcile_csv' where id=$1",
      [first.job.id],
      "23514",
    );
  },
);

for (const [name, file, state] of [
  [
    "old synthetic",
    "../../tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    "inspected",
  ],
  [
    "new synthetic",
    "../../tests/fixtures/catalogue-benchmark/synthetic/new-catalogue.pdf",
    "inspected",
  ],
  [
    "Blindtex scan",
    "../../services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf",
    "ocr_required",
  ],
]) {
  check(
    `${name}: real CPU result persists with no extraction or comparison side effects`,
    async () => {
      const bytes = await readFile(new URL(file, import.meta.url));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          /^(SYSTEMROOT|WINDIR|PATH|TEMP|TMP)$/i.test(key),
        ),
      );
      const python =
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
      const child = spawnSync(
        fileURLToPath(
          new URL(`../../services/worker/.venv/${python}`, import.meta.url),
        ),
        ["-I", "-m", "stockshift_worker.entrypoints.pdf_inspection"],
        {
          input: JSON.stringify({
            operation: "inspect_pdf",
            data: bytes.toString("base64"),
          }),
          env,
          timeout: 60000,
          maxBuffer: 65536,
        },
      );
      assert.equal(child.status, 0, child.stderr?.toString());
      const parsed = JSON.parse(child.stdout).value;
      assert.ok(parsed);
      assert.equal(parsed.state, state);
      assert.equal(parsed.page_count, 1);
      await enqueue();
      const j = await claim();
      const saved = await rpc("complete_pdf_inspection", [...lease(j), parsed]);
      assert.equal(saved.status, state);
      assert.deepEqual(saved.diagnostics, parsed.diagnostics);
      for (const table of [
        "comparison_runs",
        "extraction_runs",
        "correction_revisions",
        "comparison_results",
      ])
        assert.equal(
          Number(
            (
              await db.query(
                `select count(*) n from public.${table} where tenant_id=$1`,
                [A],
              )
            ).rows[0].n,
          ),
          0,
        );
    },
  );
}
