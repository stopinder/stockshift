// Native Docker-backed PostgreSQL: PDF queue fencing, ownership and append-only snapshots.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import { Client } from "pg";
const connection = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
};
const db = new Client(connection),
  A = randomUUID(),
  B = randomUUID(),
  owner = randomUUID(),
  other = randomUUID(),
  viewer = randomUUID(),
  a = randomUUID(),
  b = randomUUID(),
  worker = randomUUID();
const cfg = { first_page: 1, last_page: 1, strategy: "lines" };
const settings = {
  table_index: 1,
  header_row: 1,
  repeat_headers: true,
  structure_confirmed: true,
  columns: { supplier_sku: "SKU", cost_price: "Price" },
  encoding: "utf-8-sig",
  delimiter: ",",
  decimal_separator: ".",
};
async function role(user, which = "authenticated", client = db) {
  await client.query(`set role ${which}`);
  await client.query("select set_config('request.jwt.claims',$1,false)", [
    JSON.stringify({ sub: user }),
  ]);
}
async function rpc(name, args = [], client = db) {
  return (
    await client.query(
      `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`,
      args.map((a) => (Array.isArray(a) ? JSON.stringify(a) : a)),
    )
  ).rows[0].value;
}
async function enqueue(file = a, tenant = A) {
  await role(owner);
  return rpc("enqueue_pdf_extraction", [tenant, file, cfg]);
}
async function claim() {
  await role(null, "service_role");
  return rpc("claim_csv_job", [worker]);
}
function lease(j) {
  return [j.tenant_id, j.id, worker, j.lease_token];
}
function payload(j, file = a) {
  return {
    schema_version: "v1",
    tenant_id: A,
    file_id: file,
    job_id: j.id,
    provider: {
      provider: "pdfplumber",
      sdk_version: "0.11.10",
      model_version: null,
      config_hash: "a".repeat(64),
    },
    raw_artifact: {
      bucket: "catalogue-uploads",
      object_key: `${A}/${file}/original`,
    },
    completion: {
      state: "complete",
      total_units: 1,
      completed_units: 1,
      pending_units: [],
      failed_units: [],
    },
    records: [],
    evidence: [],
    warnings: [],
  };
}
async function complete(j) {
  return rpc("complete_pdf_extraction", [
    ...lease(j),
    payload(j),
    [{ page: 1, text: "SKU Price", width: 720, height: 540, table_count: 1 }],
  ]);
}
async function denied(sql, args = [], code = "42501") {
  await db.query("savepoint rejection");
  try {
    await assert.rejects(db.query(sql, args), (e) => e.code === code);
  } finally {
    await db.query("rollback to rejection; release savepoint rejection");
  }
}
function check(name, fn) {
  test(name, async () => {
    await db.query("begin");
    try {
      await fn();
    } finally {
      await db.query("rollback");
      await db.query("reset role");
    }
  });
}
before(async () => {
  await db.connect();
  await db.query("insert into auth.users(id) values($1),($2),($3)", [
    owner,
    other,
    viewer,
  ]);
  await db.query(
    "insert into public.tenants(id,name) values($1,'PDF A'),($2,'PDF B')",
    [A, B],
  );
  await db.query(
    "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner'),($1,$5,'viewer')",
    [A, owner, B, other, viewer],
  );
  for (const [file, tenant, user] of [
    [a, A, owner],
    [b, B, other],
  ])
    await db.query(
      "insert into public.source_files(id,tenant_id,created_by,original_filename,expected_byte_count,status,byte_count,verified_mime,sha256,finalized_at) values($1,$2,$3,'catalogue.pdf',10,'ready',10,'application/pdf',$4,now())",
      [file, tenant, user, "a".repeat(64)],
    );
});
after(() => db.end());
check(
  "PDF enqueue is idempotent and creates the one-of job/source references",
  async () => {
    const e = await enqueue(),
      again = await enqueue();
    assert.equal(e.job.id, again.job.id);
    assert.equal(e.extraction.id, e.job.extraction_run_id);
    assert.equal(e.job.comparison_run_id, null);
    assert.equal(e.job.kind, "extract_pdf");
  },
);
check(
  "PDF enqueue rejects cross-tenant sources, viewers and invalid page ranges",
  async () => {
    await role(owner);
    await denied("select public.enqueue_pdf_extraction($1,$2,$3)", [A, b, cfg]);
    await denied(
      "select public.enqueue_pdf_extraction($1,$2,$3)",
      [A, a, { ...cfg, last_page: 51 }],
      "23514",
    );
    await role(viewer);
    await denied("select public.enqueue_pdf_extraction($1,$2,$3)", [A, a, cfg]);
  },
);
check(
  "PDF claim and measured heartbeat/progress are fenced by lease",
  async () => {
    const e = await enqueue(),
      j = await claim();
    assert.equal(j.id, e.job.id);
    await rpc("pdf_extraction_progress", [...lease(j), 1, 1]);
    await rpc("heartbeat_csv_job", [...lease(j), 300]);
    assert.equal(
      (
        await db.query(
          "select completed_pages,total_pages,status from public.extraction_runs where id=$1",
          [e.extraction.id],
        )
      ).rows[0].status,
      "running",
    );
    await denied("select public.pdf_extraction_progress($1,$2,$3,$4,$5,$6)", [
      A,
      j.id,
      worker,
      randomUUID(),
      1,
      1,
    ]);
  },
);
check(
  "Expired PDF lease is reclaimed; stale progress and completion are rejected",
  async () => {
    await enqueue();
    const old = await claim();
    await db.query("reset role");
    await db.query(
      "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [old.id],
    );
    const current = await claim();
    assert.notEqual(current.lease_token, old.lease_token);
    await denied("select public.complete_pdf_extraction($1,$2,$3,$4,$5,$6)", [
      ...lease(old),
      payload(old),
      JSON.stringify([]),
    ]);
    await denied("select public.pdf_extraction_progress($1,$2,$3,$4,$5,$6)", [
      ...lease(old),
      1,
      1,
    ]);
    await complete(current);
  },
);
check(
  "PDF retries schedule and exhaustion persist structured extraction failure",
  async () => {
    const e = await enqueue();
    await db.query("reset role");
    await db.query("update public.jobs set max_attempts=1 where id=$1", [
      e.job.id,
    ]);
    const j = await claim();
    const failure = {
      code: "pdf_timeout",
      stage: "extract",
      message: "Select fewer pages",
      retryable: true,
    };
    await rpc("fail_csv_job", [...lease(j), failure, true]);
    assert.equal(
      (
        await db.query(
          "select status,failure_reason from public.extraction_runs where id=$1",
          [e.extraction.id],
        )
      ).rows[0].status,
      "failed",
    );
    assert.deepEqual(
      (
        await db.query("select failure_reason from public.jobs where id=$1", [
          j.id,
        ])
      ).rows[0].failure_reason,
      failure,
    );
    assert.equal(
      (await db.query("select status from public.jobs where id=$1", [j.id]))
        .rows[0].status,
      "dead_letter",
    );
  },
);
check(
  "PDF retryable failure preserves the run and permits a later attempt",
  async () => {
    const e = await enqueue(),
      j = await claim();
    await rpc("fail_csv_job", [
      ...lease(j),
      {
        code: "temporary",
        stage: "extract",
        message: "Retry",
        retryable: true,
      },
      true,
    ]);
    assert.equal(
      (
        await db.query(
          "select status from public.extraction_runs where id=$1",
          [e.extraction.id],
        )
      ).rows[0].status,
      "queued",
    );
    assert.equal(await rpc("claim_csv_job", [worker]), null);
    await db.query("reset role");
    await db.query(
      "update public.jobs set available_at=clock_timestamp()-interval '1 second' where id=$1",
      [j.id],
    );
    const second = await claim();
    assert.equal(second.attempt_count, 2);
    await complete(second);
  },
);
check(
  "PDF completion is idempotent and conflicting re-publication is rejected",
  async () => {
    await enqueue();
    const j = await claim();
    const result = await complete(j);
    assert.equal((await complete(j)).result_digest, result.result_digest);
    await denied(
      "select public.complete_pdf_extraction($1,$2,$3,$4,$5,$6)",
      [
        ...lease(j),
        {
          ...payload(j),
          warnings: [{ code: "changed", field: null, message: "changed" }],
        },
        JSON.stringify([]),
      ],
      "23514",
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from public.extraction_runs where id=$1",
          [j.extraction_run_id],
        )
      ).rows[0].n,
      1,
    );
  },
);
check(
  "Privileged PDF completion rejects forged source and evidence references",
  async () => {
    await enqueue();
    const j = await claim();
    await denied(
      "select public.complete_pdf_extraction($1,$2,$3,$4,$5,$6)",
      [...lease(j), payload(j, b), JSON.stringify([])],
      "23514",
    );
    const fake = payload(j);
    fake.evidence = [{ source_file_id: b, record_id: randomUUID() }];
    await denied("select public.complete_pdf_extraction($1,$2,$3,$4,$5,$6)", [
      ...lease(j),
      fake,
      JSON.stringify([]),
    ]);
  },
);
check(
  "PDF browser roles cannot claim, load, complete or alter worker progress",
  async () => {
    const e = await enqueue();
    await role(owner);
    for (const sql of [
      "select public.claim_csv_job($1)",
      "select public.load_pdf_extraction($1,$2,$3,$4)",
      "select public.pdf_extraction_progress($1,$2,$3,$4,$5,$6)",
      "select public.complete_pdf_extraction($1,$2,$3,$4,$5,$6)",
    ]) {
      const args = sql.includes("progress")
        ? [A, e.job.id, worker, randomUUID(), 1, 1]
        : sql.includes("complete")
          ? [A, e.job.id, worker, randomUUID(), {}, JSON.stringify([])]
          : sql.includes("load")
            ? [A, e.job.id, worker, randomUUID()]
            : [worker];
      await denied(sql, args);
    }
    await denied(
      "update public.extraction_runs set status='ready' where id=$1",
      [e.extraction.id],
    );
  },
);
check(
  "PDF evidence and corrections are append-only even for database owner",
  async () => {
    const e = await enqueue(),
      j = await claim();
    await complete(j);
    await role(owner);
    const v = await rpc("save_pdf_revision", [
      A,
      e.extraction.id,
      0,
      settings,
      {},
      true,
    ]);
    await db.query("reset role");
    await denied(
      "update public.extraction_runs set raw_pages='[]' where id=$1",
      [e.extraction.id],
      "23514",
    );
    await denied(
      "delete from public.extraction_runs where id=$1",
      [e.extraction.id],
      "23514",
    );
    await denied(
      "update public.correction_revisions set confirmed=false where id=$1",
      [v.id],
      "23514",
    );
    await denied(
      "delete from public.correction_revisions where id=$1",
      [v.id],
      "23514",
    );
  },
);
check(
  "PDF revision optimistic lock, creator/time and viewer read survive re-entry",
  async () => {
    const e = await enqueue();
    await complete(await claim());
    await role(owner);
    const v = await rpc("save_pdf_revision", [
      A,
      e.extraction.id,
      0,
      settings,
      {},
      false,
    ]);
    assert.equal(v.created_by, owner);
    assert.ok(v.created_at);
    await denied(
      "select public.save_pdf_revision($1,$2,$3,$4,$5,$6)",
      [A, e.extraction.id, 0, settings, {}, true],
      "23514",
    );
    await role(viewer);
    const rows = (
      await db.query("select * from public.correction_revisions where id=$1", [
        v.id,
      ])
    ).rows;
    assert.equal(rows[0].confirmed, false);
    await denied("select public.save_pdf_revision($1,$2,$3,$4,$5,$6)", [
      A,
      e.extraction.id,
      1,
      settings,
      {},
      true,
    ]);
  },
);
check(
  "Tenant B cannot read tenant A extraction or correction revisions",
  async () => {
    const e = await enqueue();
    await complete(await claim());
    await role(owner);
    await rpc("save_pdf_revision", [A, e.extraction.id, 0, settings, {}, true]);
    await role(other);
    assert.equal(
      (
        await db.query(
          "select * from public.extraction_runs where tenant_id=$1",
          [A],
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "select * from public.correction_revisions where tenant_id=$1",
          [A],
        )
      ).rows.length,
      0,
    );
    await denied("select public.save_pdf_revision($1,$2,$3,$4,$5,$6)", [
      B,
      e.extraction.id,
      0,
      settings,
      {},
      true,
    ]);
  },
);
check(
  "Cross-tenant extraction/revision/job foreign keys reject privileged mistakes",
  async () => {
    const e = await enqueue();
    await db.query("reset role");
    await denied(
      "insert into public.extraction_runs(tenant_id,source_file_id,created_by,configuration,config_digest) values($1,$2,$3,'{}','invalid')",
      [A, b, owner],
      "23503",
    );
    await denied(
      "insert into public.correction_revisions(tenant_id,extraction_run_id,source_file_id,revision,configuration,corrections,confirmed,created_by) values($1,$2,$3,1,'{}','{}',true,$4)",
      [B, e.extraction.id, b, other],
      "23503",
    );
    const unlinked = randomUUID();
    await db.query(
      "insert into public.extraction_runs(id,tenant_id,source_file_id,created_by,configuration,config_digest) values($1,$2,$3,$4,'{}','unlinked')",
      [unlinked, A, a, owner],
    );
    await denied(
      "insert into public.jobs(tenant_id,kind,extraction_run_id,idempotency_key) values($1,'extract_pdf',$2,'cross-tenant')",
      [B, unlinked],
      "23503",
    );
  },
);

check(
  "PDF confirmation requires typed table/header/continuation settings",
  async () => {
    const e = await enqueue();
    await complete(await claim());
    await role(owner);
    for (const invalid of [
      { ...settings, table_index: "1" },
      { ...settings, header_row: "1" },
      { ...settings, structure_confirmed: "true" },
      { ...settings, repeat_headers: null },
    ])
      await denied(
        "select public.save_pdf_revision($1,$2,$3,$4,$5,$6)",
        [A, e.extraction.id, 0, invalid, {}, true],
        "23514",
      );
    await denied(
      "select public.enqueue_pdf_extraction($1,$2,$3)",
      [A, a, { ...cfg, first_page: "1" }],
      "23514",
    );
  },
);

test("Two independent workers cannot claim the same committed PDF extraction", async () => {
  const e = await enqueue();
  await db.query("reset role");
  const first = new Client(connection),
    second = new Client(connection);
  await Promise.all([first.connect(), second.connect()]);
  try {
    await Promise.all([
      role(null, "service_role", first),
      role(null, "service_role", second),
    ]);
    const w1 = randomUUID(),
      w2 = randomUUID();
    const jobs = await Promise.all([
      rpc("claim_csv_job", [w1], first),
      rpc("claim_csv_job", [w2], second),
    ]);
    assert.equal(jobs.filter(Boolean).length, 1);
    const winner = jobs[0] ? first : second,
      w = jobs[0] ? w1 : w2,
      j = jobs.find(Boolean);
    assert.equal(j.id, e.job.id);
    await rpc(
      "complete_pdf_extraction",
      [A, j.id, w, j.lease_token, payload(j), []],
      winner,
    );
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
});
