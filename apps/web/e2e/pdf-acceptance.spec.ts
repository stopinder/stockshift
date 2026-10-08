import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Only generated loopback keys. No .env loading, hosted fallback or OCR provider.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_|STOCKSHIFT_OCR_|VERCEL)/i.test(
        key,
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
if (local.API_URL !== "http://127.0.0.1:54321")
  throw new Error("Verified local stack required");
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const db = new Client({
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
});
const python = resolve("services/worker/.venv/Scripts/python.exe");
let tenant: string, other: string;
let credentials: { email: string; password: string };
const benchmark = JSON.parse(
  readFileSync(
    "tests/fixtures/catalogue-benchmark/expected-results.json",
    "utf8",
  ),
).synthetic_export_pair;
const correction = JSON.parse(
  readFileSync("docs/CHUNK_7_CORRECTION_EXPECTATION.json", "utf8"),
);
let ocrRequests: string[];
test.beforeAll(async () => {
  await db.connect();
});
test.afterAll(async () => {
  await db.end();
});
test.beforeEach(async ({ page }) => {
  ocrRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      /ocr/i.test(url.hostname + url.pathname) ||
      ["8771", "8765"].includes(url.port)
    )
      ocrRequests.push(request.url());
  });
  expect(
    Number(
      (
        await db.query(
          "select count(*) n from public.jobs where status in ('queued','running','retry_wait')",
        )
      ).rows[0].n,
    ),
  ).toBe(0);
  tenant = randomUUID();
  other = randomUUID();
  credentials = {
    email: randomUUID() + "@stockshift.local",
    password: randomUUID(),
  };
  const user = await admin.auth.admin.createUser({
    ...credentials,
    email_confirm: true,
  });
  if (user.error) throw user.error;
  for (const [id, name] of [
    [tenant, "Acceptance workspace"],
    [other, "Other workspace"],
  ]) {
    await db.query("insert into public.tenants(id,name) values($1,$2)", [
      id,
      name,
    ]);
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
      [id, user.data.user!.id],
    );
  }
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Comparisons", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Workspace", { exact: true }).selectOption(tenant);
});
async function create(page: Page) {
  await allowance(3, 0);
  await page.getByRole("link", { name: "+ New comparison" }).click();
  await page.getByLabel("Comparison name").fill("Local PDF acceptance");
  await page.getByLabel("Supplier", { exact: true }).selectOption("new");
  await page.getByLabel("Supplier name").fill("Synthetic supplier");
  await page.getByRole("button", { name: "Continue to files" }).click();
  await expect(
    page.getByRole("heading", { name: "Add your catalogue files" }),
  ).toBeVisible();
}

async function allowance(remaining: number, files: number) {
  const value = (
    await db.query(
      "select pilot_exempt,trial_remaining,reserved_files,reserved_bytes,paid_used from public.workspace_allowances where tenant_id=$1",
      [tenant],
    )
  ).rows[0];
  expect(value.pilot_exempt).toBe(false);
  expect(value.trial_remaining).toBe(remaining);
  expect(value.reserved_files).toBe(files);
  expect(value.paid_used).toBe(0);
  const bytes = (
    await db.query(
      "select coalesce(sum(expected_byte_count),0)::text bytes from public.source_files where tenant_id=$1",
      [tenant],
    )
  ).rows[0].bytes;
  expect(String(value.reserved_bytes)).toBe(bytes);
}

async function mapAndInspect(page: Page, index: number) {
  const area = page.locator(".pdf-settings").nth(index);
  await expect(
    area.getByRole("heading", { name: "Original values and corrections" }),
  ).toBeVisible();
  for (const [label, value] of [
    ["SKU header", "SKU"],
    ["Cost header", "Price"],
    ["Description header", "Description"],
    ["Currency column", "Currency"],
    ["Pack quantity column", "Pack"],
    ["Unit column", "UOM"],
  ])
    await area.getByLabel(label!, { exact: true }).selectOption(value!);
  await area.getByText("Source text · page 1", { exact: true }).click();
  const oracle = index === 0 ? benchmark.old.rows : benchmark.new.rows;
  for (const row of oracle) {
    await expect(area.locator("pre").first()).toContainText(row.sku);
    await expect(
      area.getByText("Original: " + row.sku, { exact: true }),
    ).toBeVisible();
    await expect(
      area.getByText("Original: " + row.price, { exact: true }).first(),
    ).toBeVisible();
  }
  await expect(
    area.getByRole("button", { name: "Confirm PDF mapping" }),
  ).toBeDisabled();
  return area;
}
async function confirm(page: Page, index: number) {
  const area = page.locator(".pdf-settings").nth(index);
  await area
    .getByLabel("I checked the selected table", { exact: false })
    .check();
  await area.getByRole("button", { name: "Confirm PDF mapping" }).click();
  await expect(
    area.getByText("PDF mapping confirmed. Ready for comparison.", {
      exact: true,
    }),
  ).toBeVisible();
}
function parseExport(csv: string) {
  const lines = csv.trimEnd().split(/\r?\n/);
  const columns = lines.shift()!.split(",");
  expect(columns).toEqual(benchmark.expected_export.columns);
  return lines
    .map((line) => {
      // Export cells are all quoted. Preserve decimal strings and leading zeros.
      const cells = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((m) =>
        m[1]!.replaceAll('""', '"'),
      );
      expect(cells).toHaveLength(columns.length);
      return Object.fromEntries(
        columns.map((key: string, i: number) => [key, cells[i]]),
      );
    })
    .sort((a, b) => a.supplier_sku!.localeCompare(b.supplier_sku!));
}
for (const corrected of [false, true])
  test(`benchmark PDF ${corrected ? "documented correction" : "unmodified baseline"}: full local journey and exact export`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await create(page);
    const comparisonId = page.url().split("/").at(-1)!;
    for (const [side, fixture] of [
      ["Current", benchmark.old],
      ["New", benchmark.new],
    ] as const) {
      const area = await upload(
        page,
        side,
        side.toLowerCase() + ".pdf",
        readFileSync(fixture.file),
      );
      await worker();
      await expect(
        area.getByRole("heading", {
          name: "Digital-table candidate",
          exact: true,
        }),
      ).toBeVisible();
      await expect(area.getByLabel("Last page")).toHaveValue("1");
    }
    await noProducts();
    await allowance(3, 2);
    await expect(
      page.getByRole("button", { name: "Start comparison", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "↓ Export changed products" }),
    ).toHaveCount(0);
    await screenshot(
      page,
      info.project.name,
      corrected ? "correction-inspected" : "baseline-inspected",
    );
    for (let index = 0; index < 2; index++) {
      const area = page.locator(".pdf-settings").nth(index);
      await area
        .getByRole("button", { name: "Extract selected pages" })
        .click();
      await expect(
        area.getByText("PDF extraction queued", { exact: false }),
      ).toBeVisible();
      await worker();
      await mapAndInspect(page, index);
      await allowance(3, 2);
    }
    await expect(
      page.getByRole("button", { name: "Start comparison", exact: true }),
    ).toBeDisabled();
    if (corrected) {
      const area = page.locator(".pdf-settings").nth(1);
      await area
        .getByLabel("Correct cost_price page 1 row 3", { exact: true })
        .fill(correction.corrected_new_cost);
      await area.getByRole("button", { name: "Save correction draft" }).click();
      await expect(
        area.getByText("Correction draft saved.", { exact: true }),
      ).toBeVisible();
      const url = page.url();
      await page
        .getByRole("link", { name: "← Comparisons", exact: true })
        .click();
      await page.goto(url);
      await expect(
        area.getByLabel("Correct cost_price page 1 row 3", { exact: true }),
      ).toHaveValue(correction.corrected_new_cost);
      await expect(
        area.getByText("Original: " + correction.original_new_cost, {
          exact: true,
        }),
      ).toBeVisible();
      await mapAndInspect(page, 0); // Unsaved current mapping must still be explicit.
      await expect(
        page.getByRole("button", { name: "Start comparison", exact: true }),
      ).toBeDisabled();
      await screenshot(page, info.project.name, "correction-reopened");
    }
    await confirm(page, 0);
    await expect(
      page.getByRole("button", { name: "Start comparison", exact: true }),
    ).toBeDisabled();
    await confirm(page, 1);
    await allowance(3, 2);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Start comparison", exact: true }),
    ).toBeEnabled();
    expect(
      Number(
        (
          await db.query(
            "select count(*) n from comparison_runs where tenant_id=$1",
            [tenant],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Start comparison", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Comparison queued" }),
    ).toBeVisible();
    await worker();
    await allowance(2, 2);
    await expect(
      page.getByRole("region", { name: "Persisted outcome counts" }),
    ).toBeVisible();
    const user = createClient(local.API_URL, local.ANON_KEY, {
      auth: { persistSession: false },
    });
    const login = await user.auth.signInWithPassword(credentials);
    expect(login.error).toBeNull();
    const run = await user
      .from("comparison_runs")
      .select("id,status")
      .eq("tenant_id", tenant)
      .eq("comparison_id", comparisonId)
      .single();
    expect(run.error).toBeNull();
    expect(run.data!.status).toBe("succeeded");
    const inspections = await user
      .from("pdf_inspections")
      .select("status,page_count,diagnostics")
      .eq("tenant_id", tenant);
    expect(inspections.error).toBeNull();
    expect(inspections.data).toHaveLength(2);
    for (const inspection of inspections.data!) {
      expect(inspection.status).toBe("inspected");
      expect(inspection.page_count).toBe(1);
    }
    const extractions = await user
      .from("extraction_runs")
      .select("status,configuration,raw_pages")
      .eq("tenant_id", tenant);
    expect(extractions.error).toBeNull();
    expect(extractions.data).toHaveLength(2);
    for (const extraction of extractions.data!) {
      expect(extraction.status).toBe("ready");
      expect(extraction.configuration.provider ?? "digital").toBe("digital");
      expect(
        extraction.raw_pages.every((p: any) => p.provider !== "paddleocr-vl"),
      ).toBe(true);
    }
    const result = await user.rpc("csv_results_page", {
      p_tenant: tenant,
      p_run: run.data!.id,
      p_outcome: "",
      p_search: "",
      p_offset: 0,
    });
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(6);
    const actual = result.data
      .map((row: any) => ({
        sku: row.new_values?.supplier_sku ?? row.old_values?.supplier_sku,
        outcome: row.primary_outcome,
        change_flags: row.change_flags,
        old_cost: row.old_values?.cost_price ?? null,
        new_cost: row.new_values?.cost_price ?? null,
        cost_delta: row.cost_delta_text,
        cost_change_percent: row.cost_change_percent_text,
      }))
      .sort((a: any, b: any) => a.sku.localeCompare(b.sku));
    const expected = benchmark.expected_outcomes.map((row: any) => {
      const old = benchmark.old.rows.find((r: any) => r.sku === row.sku),
        incoming = benchmark.new.rows.find((r: any) => r.sku === row.sku);
      const value = {
        sku: row.sku,
        outcome: row.outcome,
        change_flags: row.change_flags ?? [],
        old_cost: old?.price ?? null,
        new_cost: incoming?.price ?? null,
        cost_delta: row.cost_delta ?? null,
        cost_change_percent: row.cost_change_percent ?? null,
      };
      if (corrected && row.sku === correction.supplier_sku)
        Object.assign(value, {
          outcome: correction.expected_outcome,
          change_flags: correction.expected_change_flags,
          new_cost: correction.corrected_new_cost,
          cost_delta: correction.expected_cost_delta,
          cost_change_percent: correction.expected_cost_change_percent,
        });
      return value;
    });
    expect(actual).toEqual(expected);
    for (const row of result.data) {
      const sku = row.new_values?.supplier_sku ?? row.old_values?.supplier_sku;
      const rendered = page
        .locator(".results-table tbody tr")
        .filter({ has: page.getByText(sku, { exact: true }) });
      await expect(rendered).toHaveCount(1);
      await expect(rendered).toContainText(
        row.primary_outcome === "absent"
          ? "Absent"
          : row.primary_outcome[0].toUpperCase() + row.primary_outcome.slice(1),
      );
      for (const [value, source] of [
        [row.old_values, benchmark.old],
        [row.new_values, benchmark.new],
      ]) {
        if (!value) continue;
        const oracle = source.rows.find((r: any) => r.sku === sku);
        for (const field of [
          "description",
          "currency",
          "unit",
          "pack_quantity",
          "price_basis",
          "tax_basis",
        ])
          expect(value[field]).toBe(oracle[field]);
      }
      expect(row.provenance.some((e: any) => e.locator.page === 1)).toBe(true);
    }
    const summary = await user.rpc("csv_run_summary", {
      p_tenant: tenant,
      p_run: run.data!.id,
    });
    expect(summary.error).toBeNull();
    const counts = {
      unchanged: 0,
      changed: 0,
      new: 0,
      absent: 0,
      needs_review: 0,
      ...summary.data.outcomes,
    };
    expect(counts).toEqual(
      corrected ? correction.expected_counts : benchmark.expected_counts,
    );
    expect(summary.data.unresolved).toBe(0);
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "↓ Export changed products" })
      .click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("changed_products.csv");
    const csv = readFileSync((await file.path())!, "utf8");
    const expectedExport = benchmark.expected_export.rows.filter(
      (r: any) =>
        !corrected || correction.expected_export_skus.includes(r.supplier_sku),
    );
    expect(parseExport(csv)).toEqual(expectedExport);
    writeFileSync(
      `.tools/chunk7-${info.project.name}-${corrected ? "corrected" : "baseline"}-export.csv`,
      csv,
    );
    writeFileSync(
      `.tools/chunk7-${info.project.name}-${corrected ? "corrected" : "baseline"}-evidence.json`,
      JSON.stringify(
        {
          tenant,
          comparisonId,
          runId: run.data!.id,
          actual,
          summary: { ...summary.data, outcomes: counts },
          inspections: inspections.data,
          extractionConfigurations: extractions.data!.map(
            (e) => e.configuration,
          ),
          exportRows: parseExport(csv),
          allowance: (
            await db.query(
              "select * from public.workspace_allowances where tenant_id=$1",
              [tenant],
            )
          ).rows[0],
        },
        null,
        2,
      ),
    );
    await screenshot(
      page,
      info.project.name,
      corrected ? "corrected-results" : "baseline-results",
    );
    expect(ocrRequests).toEqual([]);
    expect(errors).toEqual([]);
  });

test("Blindtex stops at persisted OCR-required without extraction, comparison or export", async ({
  page,
}, info) => {
  await create(page);
  const area = await upload(
    page,
    "Current",
    "Blindtex.pdf",
    readFileSync(
      "services/worker/tests/fixtures/catalogue_layout/remaining/awkward-catalogue.pdf",
    ),
  );
  await worker();
  await expect(
    area.getByRole("heading", { name: "OCR required", exact: true }),
  ).toBeVisible();
  await expect(area.getByText(/OCR is disabled. Upload CSV/)).toBeVisible();
  await expect(
    area.getByRole("button", { name: "Extract selected pages" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Start comparison" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "↓ Export changed products" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    area.getByRole("heading", { name: "OCR required", exact: true }),
  ).toBeVisible();
  await noProducts();
  await allowance(3, 1);
  expect(ocrRequests).toEqual([]);
  await screenshot(page, info.project.name, "blindtex-stopped");
});
async function upload(
  page: Page,
  side: "Current" | "New",
  filename: string,
  buffer: Buffer,
) {
  await page
    .getByLabel(side + " catalogue file")
    .setInputFiles({ name: filename, mimeType: "application/pdf", buffer });
  const area = page.getByRole("region", {
    name:
      "PDF import · " +
      (side === "Current" ? "current catalogue" : "new catalogue"),
  });
  await expect(
    area.getByRole("heading", { name: "PDF inspection queued" }),
  ).toBeVisible();
  await expect(
    area.getByRole("button", { name: "Extract selected pages" }),
  ).toBeDisabled();
  return area;
}
async function worker() {
  expect(
    Number(
      (
        await db.query(
          "select count(*) n from public.jobs where tenant_id<>$1 and status in ('queued','running','retry_wait')",
          [tenant],
        )
      ).rows[0].n,
    ),
  ).toBe(0);
  const run = spawnSync(
    python,
    ["-I", "-m", "stockshift_worker.entrypoints.cli", "--once"],
    {
      env: {
        ...env,
        STOCKSHIFT_SUPABASE_MODE: "local",
        STOCKSHIFT_RUNTIME: "local",
        STOCKSHIFT_LOCAL_SUPABASE_URL: local.API_URL,
        STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY,
      },
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 65536,
    },
  );
  expect(run.status, run.stderr).toBe(0);
}
async function noProducts() {
  for (const table of [
    "extraction_runs",
    "comparison_runs",
    "correction_revisions",
    "comparison_results",
  ])
    expect(
      Number(
        (
          await db.query(
            `select count(*) n from public.${table} where tenant_id=$1`,
            [tenant],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
}
async function screenshot(page: Page, project: string, name: string) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.tools/chunk7-${project}-${name}.png`,
    fullPage: true,
  });
}
