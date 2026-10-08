// Real loopback Auth/Storage/HTTP worker integration. Never calls an OCR provider.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import pdfHandler from "../../apps/web/api/pdf";
import uploadHandler from "../../apps/web/api/uploads";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { before, after, test } from "node:test";
import { Client } from "pg";
import { createClient } from "@supabase/supabase-js";
import { SupabaseUploadGateway } from "../../apps/web/server/supabase-upload-gateway";
import {
  createUploadIntent,
  finalizeUpload,
} from "../../apps/web/server/uploads";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_|STOCKSHIFT_OCR_)/i.test(
        key,
      ),
  ),
);
const status = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/supabase-local.mjs", "status", "--output", "json"],
    { env, encoding: "utf8" },
  ),
);
const url = "http://127.0.0.1:54321";
assert.equal(status.API_URL, url);
const config = {
  url,
  publishableKey: status.ANON_KEY,
  secretKey: status.SERVICE_ROLE_KEY,
};
assert.ok(config.publishableKey && config.secretKey);
const admin = createClient(url, config.secretKey, {
  auth: { persistSession: false },
});
const gateway = new SupabaseUploadGateway(config);
const connection = {
  host: "127.0.0.1",
  port: 54322,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  ssl: false,
};
const db = new Client(connection),
  tenant = randomUUID(),
  foreign = randomUUID();
const users: Array<{
  id: string;
  token: string;
  client: ReturnType<typeof createClient>;
}> = [];
before(async () => {
  Object.assign(process.env, {
    STOCKSHIFT_PDF_INSPECTION_ENABLED: "1",
    STOCKSHIFT_SUPABASE_MODE: "local",
    STOCKSHIFT_LOCAL_SUPABASE_URL: url,
    STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
    STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: config.secretKey,
  });
  await db.connect();
  // Global claims are safe only when unrelated work is absent. Never drain it for tests.
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from public.jobs where status in ('queued','running','retry_wait')",
        )
      ).rows[0].n,
    ),
    0,
    "Unfinished local jobs exist; stop instead of consuming another tenant queue",
  );
  for (const workspace of [tenant, foreign]) {
    const email = randomUUID() + "@stockshift.local",
      password = randomUUID();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ifError(created.error);
    const client = createClient(url, config.publishableKey, {
      auth: { persistSession: false },
    });
    const login = await client.auth.signInWithPassword({ email, password });
    assert.ifError(login.error);
    const user = {
      id: created.data.user!.id,
      token: login.data.session!.access_token,
      client,
    };
    users.push(user);
    await db.query(
      "insert into public.tenants(id,name) values($1,'CPU inspection integration')",
      [workspace],
    );
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
      [workspace, user.id],
    );
  }
});
after(async () => {
  await db.end();
});
async function upload(bytes: Buffer, badHash = false, skipEnqueue = false) {
  const file = await createUploadIntent(gateway, users[0].token, {
    tenantId: tenant,
    filename: "inspection.pdf",
    byteCount: bytes.length,
  });
  const uploaded = await users[0].client.storage
    .from("catalogue-uploads")
    .uploadToSignedUrl(file.path, file.token, bytes, {
      contentType: "application/pdf",
    });
  assert.ifError(uploaded.error);
  if (badHash || skipEnqueue) {
    // Test-owned ready metadata deliberately disagrees with its real private blob.
    const begun = await gateway.transition(tenant, file.fileId, users[0].id, "begin");
    await gateway.transition(tenant, file.fileId, users[0].id, "finish", {
      bytes: bytes.length,
      mime: "application/pdf",
      sha256: badHash
        ? "0".repeat(64)
        : createHash("sha256").update(bytes).digest("hex"),
    }, begun.verification_lease);
  } else {
    await finalizeUpload(gateway, users[0].token, {
      tenantId: tenant,
      fileId: file.fileId,
    });
  }
  return file;
}
async function enqueue(fileId: string) {
  const response = await users[0].client.rpc("enqueue_pdf_inspection", {
    p_tenant: tenant,
    p_file: fileId,
  });
  assert.ifError(response.error);
  return response.data;
}
function worker() {
  const python = resolve(
    "services/worker/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const child = spawnSync(
    python,
    ["-I", "-m", "stockshift_worker.entrypoints.cli", "--once"],
    {
      env: {
        ...env,
        STOCKSHIFT_SUPABASE_MODE: "local",
        STOCKSHIFT_RUNTIME: "local",
        STOCKSHIFT_LOCAL_SUPABASE_URL: url,
        STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: config.secretKey,
      },
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 65536,
    },
  );
  assert.equal(child.status, 0, "CPU worker failed");
}
async function saved(id: string) {
  const value = await users[0].client
    .from("pdf_inspections")
    .select("*")
    .eq("id", id)
    .single();
  assert.ifError(value.error);
  return value.data;
}
async function noSideEffects() {
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
            [tenant],
          )
        ).rows[0].n,
      ),
      0,
    );
}

test("concurrent inspection enqueue/claim, expired-lease recovery and private Storage CPU worker", async () => {
  const file = await upload(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
  );
  const [first, second] = await Promise.all([
    enqueue(file.fileId),
    enqueue(file.fileId),
  ]);
  assert.equal(first.job.id, second.job.id);
  assert.equal(first.inspection.id, second.inspection.id);
  const clients = [new Client(connection), new Client(connection)],
    workers = [randomUUID(), randomUUID()];
  await Promise.all(clients.map((c) => c.connect()));
  let stale: any, abandoned: string;
  try {
    await Promise.all(clients.map((c) => c.query("set role service_role")));
    const claims = await Promise.all(
      clients.map((c, i) =>
        c.query("select public.claim_csv_job($1) job", [workers[i]]),
      ),
    );
    assert.equal(claims.filter((r) => r.rows[0].job).length, 1);
    const index = claims.findIndex((r) => r.rows[0].job);
    stale = claims[index].rows[0].job;
    abandoned = workers[index];
    assert.equal(stale.id, first.job.id);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
  await db.query(
    "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [stale.id],
  );
  worker();
  const inspection = await saved(first.inspection.id);
  assert.equal(inspection.status, "inspected");
  assert.equal(inspection.page_count, 1);
  const job = (
    await db.query("select * from public.jobs where id=$1", [first.job.id])
  ).rows[0];
  assert.equal(job.status, "succeeded");
  assert.equal(job.attempt_count, 2);
  const rejected = await admin.rpc("complete_pdf_inspection", {
    p_tenant: tenant,
    p_job: stale.id,
    p_worker: abandoned!,
    p_token: stale.lease_token,
    p_result: {
      version: "cpu-inspection-v1",
      page_count: 1,
      state: "inspected",
      diagnostics: inspection.diagnostics,
    },
  });
  assert.ok(rejected.error);
  assert.equal(rejected.error.code, "42501");
  await noSideEffects();
});
for (const [name, path, state] of [
  [
    "new synthetic",
    "tests/fixtures/catalogue-benchmark/synthetic/new-catalogue.pdf",
    "inspected",
  ],
  [
    "Blindtex scan",
    "services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf",
    "ocr_required",
  ],
])
  test(`${name}: signed private upload reaches persisted CPU inspection without OCR`, async () => {
    const file = await upload(readFileSync(path));
    const queued = await enqueue(file.fileId);
    worker();
    const inspection = await saved(queued.inspection.id);
    assert.equal(inspection.status, state);
    assert.equal(inspection.page_count, 1);
    assert.equal(
      inspection.diagnostics[0].state,
      state === "inspected" ? "digital_candidate" : "ocr_required",
    );
    assert.ok(
      (
        await users[1].client.storage
          .from("catalogue-uploads")
          .download(file.path)
      ).error,
    );
    assert.equal(
      (
        await users[1].client
          .from("pdf_inspections")
          .select("id")
          .eq("id", inspection.id)
      ).data?.length,
      0,
    );
    assert.ok(
      (
        await users[1].client.rpc("enqueue_pdf_inspection", {
          p_tenant: tenant,
          p_file: file.fileId,
        })
      ).error,
    );
    await noSideEffects();
  });
test("real worker integrity failure publishes only a terminal failure, never diagnostics", async () => {
  const file = await upload(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
    true,
  );
  const queued = await enqueue(file.fileId);
  worker();
  const inspection = await saved(queued.inspection.id);
  assert.equal(inspection.status, "failed");
  assert.equal(inspection.diagnostics, null);
  assert.equal(inspection.failure_reason.code, "invalid_pdf_job");
  assert.match(
    inspection.failure_reason.message,
    /integrity verification failed/,
  );
  assert.equal(
    (
      await db.query("select status from public.jobs where id=$1", [
        queued.job.id,
      ])
    ).rows[0].status,
    "failed",
  );
  await noSideEffects();
});
async function api(handler: typeof pdfHandler, body: unknown, user = 0) {
  const res = {
    statusCode: 0,
    output: "",
    setHeader() {},
    end(value: string) {
      this.output = value;
    },
  };
  await handler(
    {
      method: "POST",
      headers: { authorization: "Bearer " + users[user].token },
      body,
    } as Parameters<typeof pdfHandler>[0],
    res as unknown as Parameters<typeof pdfHandler>[1],
  );
  return { status: res.statusCode, value: JSON.parse(res.output) };
}
test("ready-byte enqueue gap recovers through finalization API; repeats return one job and persisted states", async () => {
  const file = await upload(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/new-catalogue.pdf",
    ),
    false,
    true,
  );
  const request = { tenantId: tenant, fileId: file.fileId };
  assert.equal(
    (await api(pdfHandler, request)).value.inspection.status,
    "not_queued",
  );
  const first = await api(uploadHandler, { action: "finalize", ...request });
  assert.equal(first.status, 200);
  assert.equal(first.value.byteVerification, "verified");
  assert.equal(first.value.inspection.status, "queued");
  const second = await api(uploadHandler, { action: "finalize", ...request });
  assert.deepEqual(second.value, first.value);
  assert.equal(
    (await api(pdfHandler, request)).value.inspection.status,
    "queued",
  );
  await db.query("set role service_role");
  const workerId = randomUUID();
  const claim = (
    await db.query("select public.claim_csv_job($1) j", [workerId])
  ).rows[0].j;
  assert.equal(
    (await api(pdfHandler, request)).value.inspection.status,
    "running",
  );
  await db.query("select public.fail_csv_job($1,$2,$3,$4,$5,true)", [
    tenant,
    claim.id,
    workerId,
    claim.lease_token,
    {
      code: "transport_unavailable",
      stage: "inspect",
      message: "Synthetic interrupted attempt",
    },
  ]);
  await db.query("reset role");
  await db.query(
    "update public.jobs set available_at=clock_timestamp() where id=$1",
    [claim.id],
  );
  worker();
  const response = await api(pdfHandler, request);
  assert.equal(response.status, 200);
  assert.equal(response.value.inspection.status, "inspected");
  assert.equal(response.value.inspection.pageCount, 1);
  assert.equal(
    response.value.comparisonEligibility,
    "requires_confirmed_extraction",
  );
  assert.equal((await api(pdfHandler, request, 1)).status, 403);
  await noSideEffects();
});
test("lost enqueue response preserves ready bytes and retries idempotently", async () => {
  const file = await upload(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
    false,
    true,
  );
  const real = gateway.enqueueInspection.bind(gateway);
  gateway.enqueueInspection = async (...args) => {
    await real(...args);
    throw new Error("Simulated lost response");
  };
  try {
    await assert.rejects(
      finalizeUpload(gateway, users[0].token, {
        tenantId: tenant,
        fileId: file.fileId,
      }),
      { status: 503 },
    );
  } finally {
    gateway.enqueueInspection = real;
  }
  assert.equal(
    (
      await db.query("select status from public.source_files where id=$1", [
        file.fileId,
      ])
    ).rows[0].status,
    "ready",
  );
  const response = await api(uploadHandler, {
    action: "finalize",
    tenantId: tenant,
    fileId: file.fileId,
  });
  assert.equal(response.status, 200);
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from public.pdf_inspections where source_file_id=$1",
          [file.fileId],
        )
      ).rows[0].n,
    ),
    1,
  );
  worker();
  await noSideEffects();
});
test("capability-disabled and hosted-mode PDF requests reject without enqueue or byte-state mutation", async () => {
  const file = await upload(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/new-catalogue.pdf",
    ),
    false,
    true,
  );
  process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED = "0";
  try {
    assert.equal(
      (
        await api(uploadHandler, {
          action: "create",
          tenantId: tenant,
          filename: "disabled.pdf",
          byteCount: 10,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await api(uploadHandler, {
          action: "finalize",
          tenantId: tenant,
          fileId: file.fileId,
        })
      ).status,
      422,
    );
    assert.equal(
      (await api(pdfHandler, { tenantId: tenant, fileId: file.fileId })).status,
      422,
    );
    assert.equal(
      Number(
        (
          await db.query(
            "select count(*) n from public.pdf_inspections where source_file_id=$1",
            [file.fileId],
          )
        ).rows[0].n,
      ),
      0,
    );
  } finally {
    process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED = "1";
  }
  process.env.STOCKSHIFT_SUPABASE_MODE = "hosted";
  try {
    assert.equal(
      (
        await api(uploadHandler, {
          action: "create",
          tenantId: tenant,
          filename: "hosted.pdf",
          byteCount: 10,
        })
      ).status,
      422,
    );
    assert.equal(
      (await api(pdfHandler, { tenantId: tenant, fileId: file.fileId })).status,
      422,
    );
  } finally {
    process.env.STOCKSHIFT_SUPABASE_MODE = "local";
  }
});
test("persisted scan and failure responses retain explicit states and no comparison eligibility", async () => {
  for (const state of ["ocr_required", "failed"]) {
    const row = (
      await db.query(
        "select source_file_id from public.pdf_inspections where tenant_id=$1 and status=$2",
        [tenant, state],
      )
    ).rows[0];
    const response = await api(pdfHandler, {
      tenantId: tenant,
      fileId: row.source_file_id,
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.byteVerification, "verified");
    assert.equal(response.value.inspection.status, state);
    assert.equal(
      response.value.comparisonEligibility,
      "requires_confirmed_extraction",
    );
    if (state === "failed")
      assert.equal(response.value.inspection.failure.code, "invalid_pdf_job");
  }
});
