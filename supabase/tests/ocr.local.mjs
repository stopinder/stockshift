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
const cfg = {
  first_page: 1,
  last_page: 1,
  strategy: "lines",
  provider: "auto",
  model_version: "PaddleOCR-VL-1.6",
  dpi: 144,
  ocr_version: "1",
};
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

const hash = "b".repeat(64),
  response = {
    parsing_res_list: [
      {
        block_label: "table",
        block_content:
          "<table><tr><td>SKU</td><td>Price</td></tr><tr><td>001</td><td>1.00</td></tr></table>",
        block_bbox: null,
        confidence: null,
      },
    ],
  };
check(
  "OCR opt-in rejects URLs, unsupported render settings and missing model identity",
  async () => {
    await role(owner);
    for (const configuration of [
      { ...cfg, endpoint: "https://other.test" },
      { ...cfg, dpi: 300 },
      { ...cfg, model_version: null },
    ])
      await denied(
        "select public.enqueue_pdf_extraction($1,$2,$3)",
        [A, a, configuration],
        "23514",
      );
  },
);
check("OCR retry budget prevents a fourth provider request", async () => {
  const e = await enqueue();
  await db.query("reset role");
  await db.query("update public.jobs set max_attempts=4 where id=$1", [
    e.job.id,
  ]);
  for (let i = 0; i < 3; i++) {
    const j = await claim();
    await event(j, "request");
    await event(j, "failed", {
      code: "ocr_timeout",
      message: "OCR timeout",
      retryable: true,
    });
    await rpc("fail_csv_job", [
      ...lease(j),
      {
        code: "ocr_timeout",
        stage: "extract",
        message: "OCR timeout",
        retryable: true,
      },
      true,
    ]);
    await db.query("reset role");
    await db.query(
      "update public.jobs set available_at=now()-interval '1 second' where id=$1",
      [j.id],
    );
  }
  const j = await claim();
  await denied(
    "select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)",
    [...lease(j), "request", 1, hash, {}],
    "23514",
  );
});
check(
  "partial OCR retry reuses a completed page with no duplicate usage",
  async () => {
    await role(owner);
    await rpc("enqueue_pdf_extraction", [A, a, { ...cfg, last_page: 2 }]);
    let j = await claim();
    await event(j, "request");
    await event(j, "ready", response);
    await event(j, "request", {}, 2);
    await event(
      j,
      "failed",
      { code: "ocr_rate_limit", message: "OCR busy", retryable: true },
      2,
    );
    await rpc("fail_csv_job", [
      ...lease(j),
      {
        code: "ocr_rate_limit",
        stage: "extract",
        message: "OCR busy",
        retryable: true,
      },
      true,
    ]);
    await db.query("reset role");
    await db.query(
      "update public.jobs set available_at=now()-interval '1 second' where id=$1",
      [j.id],
    );
    j = await claim();
    await event(j, "request");
    await event(j, "request", {}, 2);
    const loaded = await rpc("load_pdf_extraction", lease(j));
    assert.equal(loaded.ocr_cache["1"].status, "ready");
    assert.equal(loaded.ocr_cache["1"].request_count, 1);
    assert.equal(loaded.ocr_cache["2"].request_count, 2);
  },
);
async function event(j, kind, value = {}, page = 1, h = hash) {
  return rpc("record_ocr_page", [...lease(j), kind, page, h, value]);
}
check(
  "OCR opt-in enqueue is idempotent and different from digital extraction",
  async () => {
    const e = await enqueue(),
      again = await enqueue();
    assert.equal(e.job.id, again.job.id);
    await role(owner);
    const digital = await rpc("enqueue_pdf_extraction", [
      A,
      a,
      { first_page: 1, last_page: 1, strategy: "lines" },
    ]);
    assert.notEqual(e.job.id, digital.job.id);
  },
);
check(
  "browser cannot access OCR cache, record usage or mutate evidence",
  async () => {
    await enqueue();
    const j = await claim();
    await role(owner);
    await denied("select * from private.ocr_pages");
    await denied("select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)", [
      ...lease(j),
      "request",
      1,
      hash,
      {},
    ]);
  },
);
check(
  "OCR cache authorizes request once per lease and preserves exact raw output",
  async () => {
    await enqueue();
    const j = await claim();
    await event(j, "request");
    await event(j, "request");
    await event(j, "ready", response);
    await event(j, "ready", response);
    const context = await rpc("load_pdf_extraction", lease(j));
    assert.equal(context.ocr_cache["1"].request_count, 1);
    assert.deepEqual(context.ocr_cache["1"].response, response);
    assert.equal(context.ocr_cache["1"].status, "ready");
  },
);
check(
  "OCR completion requires authorized page and tenant/lease ownership",
  async () => {
    await enqueue();
    const j = await claim();
    await denied("select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)", [
      ...lease(j),
      "ready",
      1,
      hash,
      response,
    ]);
    await denied("select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)", [
      B,
      j.id,
      worker,
      j.lease_token,
      "request",
      1,
      hash,
      {},
    ]);
    await denied(
      "select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)",
      [...lease(j), "request", 2, hash, {}],
      "23514",
    );
  },
);
check(
  "OCR cache immutable completion rejects conflicting output/hash",
  async () => {
    await enqueue();
    const j = await claim();
    await event(j, "request");
    await event(j, "ready", response);
    await denied(
      "select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)",
      [...lease(j), "ready", 1, hash, { parsing_res_list: [] }],
      "23514",
    );
    await denied(
      "select public.record_ocr_page($1,$2,$3,$4,$5,$6,$7,$8)",
      [...lease(j), "request", 1, "c".repeat(64), {}],
      "23514",
    );
    await db.query("reset role");
    await denied("update private.ocr_pages set response=$1", [{}], "23514");
  },
);
check(
  "OCR failure persists structured details and retries preserve earlier completed pages",
  async () => {
    await enqueue();
    let j = await claim();
    await event(j, "request");
    await event(j, "failed", {
      code: "ocr_rate_limit",
      message: "OCR busy",
      retryable: true,
    });
    await rpc("fail_csv_job", [
      ...lease(j),
      {
        code: "ocr_rate_limit",
        stage: "extract",
        message: "OCR busy",
        retryable: true,
      },
      true,
    ]);
    await db.query("reset role");
    await db.query(
      "update public.jobs set available_at=now()-interval '1 second' where id=$1",
      [j.id],
    );
    j = await claim();
    await event(j, "request");
    const loaded = await rpc("load_pdf_extraction", lease(j));
    assert.equal(loaded.ocr_cache["1"].request_count, 2);
    assert.equal(j.attempt_count, 2);
  },
);
check(
  "OCR source/tenant foreign keys reject cross-tenant cache references",
  async () => {
    const e = await enqueue();
    await db.query("reset role");
    await denied(
      "insert into private.ocr_pages(tenant_id,extraction_run_id,source_file_id,page,request_hash,status,last_lease) values($1,$2,$3,1,$4,'requested',$5)",
      [B, e.extraction.id, b, hash, worker],
      "23503",
    );
  },
);
check(
  "OCR rows need explicit source verification before immutable revision confirmation",
  async () => {
    await enqueue();
    const j = await claim();
    const p = payload(j),
      rid = randomUUID(),
      eid = randomUUID();
    p.records = [
      {
        record_id: rid,
        raw_cells: [
          { column_name: "Column 1", value: "001", evidence_id: eid },
        ],
        semantic_candidates: {},
      },
    ];
    p.evidence = [
      {
        schema_version: "v1",
        record_id: rid,
        evidence_id: eid,
        source_file_id: a,
        field_name: "Column 1",
        raw_text: "001",
        artifact: p.raw_artifact,
        locator: {
          page: 1,
          row: 2,
          table: "1",
          column: "Column 1",
          sheet: null,
          cell: "2:1",
          bounding_polygon: null,
          coordinate_system: null,
        },
      },
    ];
    p.warnings = [
      {
        code: "ocr_verification_required",
        field: rid,
        message: "Verify source",
      },
    ];
    await rpc("complete_pdf_extraction", [
      ...lease(j),
      p,
      [{ page: 1, text: "001", provider: "paddleocr-vl" }],
    ]);
    await role(owner);
    await denied(
      "select public.save_pdf_revision($1,$2,$3,$4,$5,$6)",
      [A, j.extraction_run_id, 0, settings, {}, true],
      "23514",
    );
    const saved = await rpc("save_pdf_revision", [
      A,
      j.extraction_run_id,
      0,
      { ...settings, ocr_verified_rows: [rid] },
      {},
      true,
    ]);
    assert.equal(saved.created_by, owner);
    assert.deepEqual(saved.configuration.ocr_verified_rows, [rid]);
    await role(other);
    assert.equal(
      (
        await db.query(
          "select * from public.correction_revisions where id=$1",
          [saved.id],
        )
      ).rowCount,
      0,
    );
  },
);
