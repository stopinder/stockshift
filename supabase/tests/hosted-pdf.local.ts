// Hosted-mode production code with strict fake-origin -> native loopback routing.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { SupabaseUploadGateway } from "../../apps/web/server/supabase-upload-gateway";
import {
  createUploadIntent,
  finalizeUpload,
} from "../../apps/web/server/uploads";
import pdfHandler from "../../apps/web/api/pdf";
import exportHandler, {
  changedProductsCsv,
} from "../../apps/web/server/export";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_.*SUPABASE_|STOCKSHIFT_OCR_|VERCEL)/i.test(
        k,
      ),
  ),
);
const local = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/supabase-local.mjs", "status", "--output", "json"],
    { env, encoding: "utf8" },
  ),
);
assert.equal(local.API_URL, "http://127.0.0.1:54321");
const origin = "https://cpu-fixture.supabase.co";
const gateway = new SupabaseUploadGateway({
  mode: "hosted",
  url: origin,
  publishableKey: local.ANON_KEY,
  secretKey: local.SERVICE_ROLE_KEY,
});
const db = new Client({
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
});
const tenant = randomUUID(),
  workerId = randomUUID(),
  foreign = randomUUID();
const workers = new Set([workerId]);
const savedEnv = { ...process.env },
  originalFetch = globalThis.fetch;
let user: any,
  outsider: any,
  serverUrl = "";
let networkRequests = 0;
const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/api/export")) return exportHandler(req, res);
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const request = Object.assign(req, {
    body: JSON.parse(Buffer.concat(buffers).toString()),
  });
  return pdfHandler(request, res);
});
function capabilities(inspection = "1", extraction = "1") {
  Object.assign(process.env, {
    STOCKSHIFT_SUPABASE_MODE: "hosted",
    STOCKSHIFT_SUPABASE_URL: origin,
    STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: local.ANON_KEY,
    STOCKSHIFT_SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY,
    STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: inspection,
    STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: extraction,
    STOCKSHIFT_OCR_ENABLED: "0",
  });
  delete process.env.STOCKSHIFT_CSV_ONLY;
}
before(async () => {
  await db.connect();
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from jobs where status in ('queued','running','retry_wait')",
        )
      ).rows[0].n,
    ),
    0,
    "Unrelated local jobs must not be consumed",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from private.cpu_pdf_workers where expires_at>clock_timestamp()",
        )
      ).rows[0].n,
    ),
    0,
    "Existing capability registrations must be retained; stop if active",
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  serverUrl = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let mapped = url;
    if (url.startsWith(origin + "/"))
      mapped = local.API_URL + url.slice(origin.length);
    else
      assert.ok(
        url.startsWith(local.API_URL + "/") || url.startsWith(serverUrl + "/"),
        "Network confined to native loopback",
      );
    networkRequests++;
    return originalFetch(
      input instanceof Request ? new Request(mapped, input) : mapped,
      { ...init, redirect: "error" },
    );
  };
  capabilities();
  const admin = createClient(origin, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  for (const [workspace, name] of [
    [tenant, "user"],
    [foreign, "outsider"],
  ]) {
    const email = randomUUID() + "@stockshift.local",
      password = randomUUID();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ifError(created.error);
    const client = createClient(origin, local.ANON_KEY, {
      auth: { persistSession: false },
    });
    const login = await client.auth.signInWithPassword({ email, password });
    assert.ifError(login.error);
    const identity = {
      id: created.data.user!.id,
      token: login.data.session!.access_token,
      client,
    };
    if (name === "user") user = identity;
    else outsider = identity;
    await db.query(
      "insert into tenants(id,name) values($1,'Hosted CPU local test')",
      [workspace],
    );
    await db.query(
      "insert into tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
      [workspace, identity.id],
    );
  }
});
after(async () => {
  globalThis.fetch = originalFetch;
  process.env = savedEnv;
  await db.query(
    "delete from private.cpu_pdf_workers where worker_id=any($1::uuid[])",
    [[...workers]],
  );
  await db.end();
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});
async function advertise(inspection = true, extraction = true, id = workerId) {
  workers.add(id);
  await db.query("select public.register_cpu_pdf_worker($1,$2,$3)", [
    id,
    inspection,
    extraction,
  ]);
}
async function uploaded(data: Buffer, filename = "catalogue.pdf") {
  const file = await createUploadIntent(gateway, user.token, {
    tenantId: tenant,
    filename,
    byteCount: data.length,
  });
  assert.ifError(
    (
      await user.client.storage
        .from("catalogue-uploads")
        .uploadToSignedUrl(file.path, file.token, data, {
          contentType: filename.endsWith(".pdf")
            ? "application/pdf"
            : "text/csv",
        })
    ).error,
  );
  await finalizeUpload(gateway, user.token, {
    tenantId: tenant,
    fileId: file.fileId,
  });
  return file.fileId;
}
async function worker(inspection = "1", extraction = "1") {
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from jobs where tenant_id<>$1 and status in ('queued','running','retry_wait')",
          [tenant],
        )
      ).rows[0].n,
    ),
    0,
  );
  const result = spawnSync(
    resolve("services/worker/.venv/Scripts/python.exe"),
    ["services/worker/tests/hosted_cpu_local.py"],
    {
      env: {
        ...env,
        STOCKSHIFT_SUPABASE_MODE: "hosted",
        STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: inspection,
        STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: extraction,
        STOCKSHIFT_OCR_ENABLED: "0",
        STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY,
        STOCKSHIFT_TEST_WORKER_ID: workerId,
      },
      encoding: "utf8",
      timeout: 90000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
}
async function inspection(id: string) {
  return (
    await db.query("select * from pdf_inspections where source_file_id=$1", [
      id,
    ])
  ).rows[0];
}
async function extraction(
  id: string,
  configuration: object = {
    first_page: 1,
    last_page: 1,
    strategy: "lines",
  },
) {
  const result = await user.client.rpc("enqueue_pdf_extraction", {
    p_tenant: tenant,
    p_file: id,
    p_configuration: configuration,
  });
  assert.ifError(result.error);
  return result.data.extraction.id;
}
async function row(id: string) {
  return (await db.query("select * from extraction_runs where id=$1", [id]))
    .rows[0];
}
async function state(id: string, identity = user) {
  return fetch(serverUrl + "/api/pdf", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${identity.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tenantId: tenant, fileId: id }),
  });
}

test("missing, conflicting and expired worker advertisements fail closed; matching profiles accepted", async () => {
  await assert.rejects(gateway.verifyPdfCapabilities(), { status: 503 });
  await advertise(true, false);
  await assert.rejects(gateway.verifyPdfCapabilities(), { status: 503 });
  capabilities("1", "0");
  await gateway.verifyPdfCapabilities();
  const mixed = randomUUID();
  await advertise(true, true, mixed);
  await assert.rejects(gateway.verifyPdfCapabilities(), { status: 503 });
  await db.query("delete from private.cpu_pdf_workers where worker_id=$1", [
    mixed,
  ]);
  await db.query(
    "update private.cpu_pdf_workers set expires_at=clock_timestamp()-interval '1 second' where worker_id=$1",
    [workerId],
  );
  await assert.rejects(gateway.verifyPdfCapabilities(), { status: 503 });
  capabilities();
  await advertise();
  await gateway.verifyPdfCapabilities();
  assert.ok(
    (
      await user.client.rpc("register_cpu_pdf_worker", {
        p_worker: workerId,
        p_inspection: true,
        p_extraction: true,
      })
    ).error,
  );
  assert.ok(
    (
      await user.client.rpc("cpu_pdf_workers_agree", {
        p_inspection: true,
        p_extraction: true,
      })
    ).error,
  );
});
test("inspection-only allows real CPU inspection but cannot extract or compare", async () => {
  capabilities("1", "0");
  await advertise(true, false);
  const id = await uploaded(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
  );
  await worker("1", "0");
  assert.equal((await inspection(id)).status, "inspected");
  assert.equal((await state(id)).status, 200);
  assert.equal((await state(id, outsider)).status, 403);
  const e = await extraction(id);
  await worker("1", "0");
  assert.equal((await row(e)).status, "failed");
  assert.equal((await row(e)).payload, null);
  capabilities();
  await advertise();
});
test("hosted digital pair uses confirmed complete revisions and exact six outcomes/three-row export", async () => {
  capabilities();
  await advertise();
  const manifest = JSON.parse(
    readFileSync(
      "tests/fixtures/catalogue-benchmark/expected-results.json",
      "utf8",
    ),
  ).synthetic_export_pair;
  const ids = [],
    revisions = [];
  const mapping = {
    encoding: "utf-8-sig",
    delimiter: ",",
    decimal_separator: ".",
    columns: {
      supplier_sku: "SKU",
      cost_price: "Price",
      description: "Description",
      currency: "Currency",
      pack_quantity: "Pack",
      unit: "UOM",
    },
    currency: null,
    pack_quantity: null,
    unit: null,
    price_basis: "unit",
    tax_basis: "net",
    table_index: 1,
    header_row: 1,
    repeat_headers: true,
    structure_confirmed: true,
  };
  for (const side of ["old", "new"]) {
    const id = await uploaded(readFileSync(manifest[side].file));
    ids.push(id);
    await worker();
    assert.equal((await inspection(id)).status, "inspected");
    const e = await extraction(id);
    await worker();
    const extracted = await row(e);
    assert.equal(extracted.status, "ready");
    assert.equal(extracted.payload.provider.provider, "pdfplumber");
    assert.equal(extracted.payload.completion.state, "complete");
    const revision = await user.client.rpc("save_pdf_revision", {
      p_tenant: tenant,
      p_extraction: e,
      p_expected: 0,
      p_configuration: mapping,
      p_corrections: {},
      p_confirmed: false,
    });
    assert.ifError(revision.error);
    revisions.push({ e, id: revision.data.id });
  }
  const comp = await user.client
    .from("comparisons")
    .insert({ tenant_id: tenant, title: "Hosted CPU exact pair" })
    .select()
    .single();
  assert.ifError(comp.error);
  assert.ifError(
    (
      await user.client.from("comparison_files").insert(
        ids.map((id, index) => ({
          tenant_id: tenant,
          comparison_id: comp.data.id,
          source_file_id: id,
          side: index ? "incoming" : "current",
        })),
      )
    ).error,
  );
  const enqueue = () =>
    user.client.rpc("enqueue_comparison_job", {
      p_tenant: tenant,
      p_comparison: comp.data.id,
      p_key: randomUUID(),
      p_current_options: { format: "pdf", revision_id: revisions[0]!.id },
      p_incoming_options: { format: "pdf", revision_id: revisions[1]!.id },
    });
  assert.ok(
    (await enqueue()).error,
    "Draft revisions cannot bypass confirmation",
  );
  for (const revision of revisions) {
    const confirmed = await user.client.rpc("save_pdf_revision", {
      p_tenant: tenant,
      p_extraction: revision.e,
      p_expected: 1,
      p_configuration: mapping,
      p_corrections: {},
      p_confirmed: true,
    });
    assert.ifError(confirmed.error);
    revision.id = confirmed.data.id;
  }
  const job = await enqueue();
  assert.ifError(job.error);
  await worker();
  const results = await user.client.rpc("csv_results_page", {
    p_tenant: tenant,
    p_run: job.data.comparison_run_id,
    p_outcome: "",
    p_search: "",
    p_offset: 0,
  });
  assert.ifError(results.error);
  const actual = results.data
    .map((r: any) => ({
      sku: r.new_values?.supplier_sku ?? r.old_values?.supplier_sku,
      outcome: r.primary_outcome,
      change_flags: r.change_flags,
      old_cost: r.old_values?.cost_price ?? null,
      new_cost: r.new_values?.cost_price ?? null,
      cost_delta: r.cost_delta_text,
      cost_change_percent: r.cost_change_percent_text,
    }))
    .sort((a: any, b: any) => a.sku.localeCompare(b.sku));
  const expected = manifest.expected_outcomes.map((r: any) => ({
    sku: r.sku,
    outcome: r.outcome,
    change_flags: r.change_flags ?? [],
    old_cost:
      manifest.old.rows.find((v: any) => v.sku === r.sku)?.price ?? null,
    new_cost:
      manifest.new.rows.find((v: any) => v.sku === r.sku)?.price ?? null,
    cost_delta: r.cost_delta ?? null,
    cost_change_percent: r.cost_change_percent ?? null,
  }));
  assert.deepEqual(actual, expected);
  const response = await fetch(
    `${serverUrl}/api/export?tenant=${tenant}&run=${job.data.comparison_run_id}`,
    { headers: { Authorization: `Bearer ${user.token}` } },
  );
  assert.equal(response.status, 200);
  const csv = await response.text();
  const expectedCsv = changedProductsCsv(manifest.expected_export.rows);
  assert.deepEqual(csv.split("\r\n").sort(), expectedCsv.split("\r\n").sort());
});
test("Blindtex remains OCR-required; forced digital and auto jobs cannot call a provider or confirm", async () => {
  const id = await uploaded(
    readFileSync(
      "services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf",
    ),
  );
  await worker();
  assert.equal((await inspection(id)).status, "ocr_required");
  for (const provider of ["digital", "auto"]) {
    const e = await extraction(id, {
      first_page: 1,
      last_page: 1,
      strategy: "lines",
      ...(provider === "auto"
        ? {
            provider,
            model_version: "PaddleOCR-VL-1.6",
            dpi: 144,
            ocr_version: "1",
          }
        : {}),
    });
    await worker();
    assert.equal((await row(e)).status, "failed");
    assert.equal((await row(e)).payload, null);
    assert.ok(
      (
        await user.client.rpc("save_pdf_revision", {
          p_tenant: tenant,
          p_extraction: e,
          p_expected: 0,
          p_configuration: {},
          p_corrections: {},
          p_confirmed: true,
        })
      ).error,
    );
  }
  assert.equal((await inspection(id)).status, "ocr_required");
  assert.equal(
    Number(
      (
        await db.query(
          "select count(*) n from private.ocr_pages where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
    ),
    0,
  );
});
test("default-off hosted CSV path still finalizes and compares without a worker advertisement", async () => {
  capabilities("0", "0");
  await db.query(
    "delete from private.cpu_pdf_workers where worker_id=any($1::uuid[])",
    [[...workers]],
  );
  const id = await uploaded(
    Buffer.from("sku,price\n00042,4.20\n"),
    "catalogue.csv",
  );
  assert.equal(
    (await gateway.sourceFile(tenant, id, user.token)).status,
    "ready",
  );
  assert.ok(networkRequests > 0);
  const current = await uploaded(
    Buffer.from("sku,price\n00042,5.25\n"),
    "old.csv",
  );
  const comp = await user.client
    .from("comparisons")
    .insert({ tenant_id: tenant, title: "Hosted default CSV" })
    .select()
    .single();
  assert.ifError(comp.error);
  assert.ifError(
    (
      await user.client.from("comparison_files").insert([
        {
          tenant_id: tenant,
          comparison_id: comp.data.id,
          source_file_id: current,
          side: "current",
        },
        {
          tenant_id: tenant,
          comparison_id: comp.data.id,
          source_file_id: id,
          side: "incoming",
        },
      ])
    ).error,
  );
  const options = {
    encoding: "utf-8-sig",
    delimiter: ",",
    decimal_separator: ".",
    columns: { supplier_sku: "sku", cost_price: "price" },
    currency: "GBP",
    pack_quantity: "1",
    unit: "each",
    price_basis: "unit",
    tax_basis: "net",
  };
  const job = await user.client.rpc("enqueue_comparison_job", {
    p_tenant: tenant,
    p_comparison: comp.data.id,
    p_key: randomUUID(),
    p_current_options: options,
    p_incoming_options: options,
  });
  assert.ifError(job.error);
  await worker("0", "0");
  const result = await user.client.rpc("csv_results_page", {
    p_tenant: tenant,
    p_run: job.data.comparison_run_id,
    p_outcome: "",
    p_search: "",
    p_offset: 0,
  });
  assert.ifError(result.error);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].old_values.supplier_sku, "00042");
  assert.equal(result.data[0].cost_delta_text, "-1.05");
  capabilities();
});
