import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
test.beforeAll(async () => {
  await db.connect();
});
test.afterAll(async () => {
  await db.end();
});
test.beforeEach(async ({ page }) => {
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
    [tenant, "Inspection workspace"],
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
  await page.getByRole("link", { name: "+ New comparison" }).click();
  await page.getByLabel("Comparison name").fill("Inspection UI checks");
  await page.getByLabel("Supplier", { exact: true }).selectOption("new");
  await page.getByLabel("Supplier name").fill("Synthetic supplier");
  await page.getByRole("button", { name: "Continue to files" }).click();
  await expect(
    page.getByRole("heading", { name: "Add your catalogue files" }),
  ).toBeVisible();
}
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
    path: `.tools/chunk6-${project}-${name}.png`,
    fullPage: true,
  });
}

test("synthetic pair: verification, queued/running, persisted candidates, return and stopped polling", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await create(page);
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/uploads", async (route) => {
    if (route.request().postDataJSON().action !== "finalize")
      return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.getByLabel("Current catalogue file").setInputFiles({
    name: "old.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
  });
  await expect(
    page.getByText("Verifying file…", { exact: true }),
  ).toBeVisible();
  release();
  const current = page.locator(".pdf-settings").first();
  await expect(
    current.getByRole("heading", { name: "PDF inspection queued" }),
  ).toBeVisible();
  await page.unroute("**/api/uploads");
  const pendingUrl = page.url();
  await page.getByRole("link", { name: "← Comparisons", exact: true }).click();
  await page.goto(pendingUrl);
  await expect(
    current.getByRole("heading", { name: "PDF inspection queued" }),
  ).toBeVisible();
  const claim = await admin.rpc("claim_csv_job", { p_worker: randomUUID() });
  expect(claim.error).toBeNull();
  expect(claim.data.kind).toBe("inspect_pdf");
  await expect(
    current.getByRole("heading", { name: "PDF inspection running" }),
  ).toBeVisible();
  await db.query(
    "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1 and tenant_id=$2",
    [claim.data.id, tenant],
  );
  await worker();
  await expect(
    current.getByRole("heading", {
      name: "Digital-table candidate",
      exact: true,
    }),
  ).toBeVisible();
  const incoming = await upload(
    page,
    "New",
    "new.pdf",
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/new-catalogue.pdf",
    ),
  );
  await worker();
  await expect(
    incoming.getByRole("heading", {
      name: "Digital-table candidate",
      exact: true,
    }),
  ).toBeVisible();
  await expect(current.getByLabel("Last page")).toHaveValue("1");
  await expect(
    current.getByRole("button", { name: "Extract selected pages" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Start comparison" }),
  ).toBeDisabled();
  await noProducts();
  await screenshot(page, info.project.name, "synthetic-pair");
  const url = page.url();
  await page.getByRole("link", { name: "← Comparisons", exact: true }).click();
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Digital-table candidate", exact: true }),
  ).toHaveCount(2);
  let reads = 0;
  page.on("request", (req) => {
    if (req.url().endsWith("/api/pdf")) reads++;
  });
  await page.waitForTimeout(3400);
  expect(reads).toBe(0);
  expect(errors).toEqual([]);
  await noProducts();
});

test("Blindtex scan: persisted OCR-required, disabled extraction and no provider calls", async ({
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
  await expect(area.getByLabel("Last page")).toHaveValue("1");
  await expect(
    area.getByRole("button", { name: "Extract selected pages" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Start comparison" }),
  ).toBeDisabled();
  await screenshot(page, info.project.name, "blindtex");
  await page.reload();
  await expect(
    area.getByRole("heading", { name: "OCR required", exact: true }),
  ).toBeVisible();
  await noProducts();
});

test("enqueue response interruption, manual retry, transient read failure and terminal inspection failure", async ({
  page,
}, info) => {
  await create(page);
  await page.route("**/api/uploads", async (route) => {
    if (route.request().postDataJSON().action !== "finalize")
      return route.continue();
    // Simulate loss after verified readiness but before enqueue, using only test-owned rows.
    const body = route.request().postDataJSON();
    const gateway = await import("../server/supabase-upload-gateway");
    const file = (
      await db.query(
        "select created_by,expected_byte_count,object_name from source_files where id=$1 and tenant_id=$2",
        [body.fileId, tenant],
      )
    ).rows[0];
    const bytes = Buffer.from("%PDF-1.7 broken");
    const { createHash } = await import("node:crypto");
    const localGateway = new gateway.SupabaseUploadGateway({
      url: local.API_URL,
      publishableKey: local.ANON_KEY,
      secretKey: local.SERVICE_ROLE_KEY,
    });
    const begun = await localGateway.transition(
      tenant,
      body.fileId,
      file.created_by,
      "begin",
    );
    await localGateway.transition(
      tenant,
      body.fileId,
      file.created_by,
      "finish",
      {
        bytes: bytes.length,
        mime: "application/pdf",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      begun.verification_lease,
    );
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Retry finalization" }),
    });
  });
  await page.getByLabel("Current catalogue file").setInputFiles({
    name: "broken.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7 broken"),
  });
  const area = page.locator(".pdf-settings");
  await expect(
    area.getByRole("button", { name: "Retry inspection enqueue" }),
  ).toBeVisible();
  await page.unroute("**/api/uploads");
  await area.getByRole("button", { name: "Retry inspection enqueue" }).click();
  await expect(
    area.getByRole("heading", { name: "PDF inspection queued" }),
  ).toBeVisible();
  await worker();
  await expect(
    area.getByRole("heading", { name: "PDF inspection failed" }),
  ).toBeVisible();
  await expect(
    area.getByRole("button", { name: "Retry inspection enqueue" }),
  ).toHaveCount(0);
  await page.route("**/api/pdf", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: '{"error":"Inspection status unavailable. Retry."}',
    }),
  );
  await page.reload();
  await expect(
    area.getByRole("button", { name: "Retry status check" }),
  ).toBeVisible();
  await page.unroute("**/api/pdf");
  await area.getByRole("button", { name: "Retry status check" }).click();
  await expect(
    area.getByRole("heading", { name: "PDF inspection failed" }),
  ).toBeVisible();
  await screenshot(page, info.project.name, "failure");
  await noProducts();
});

test("late inspection responses do not survive workspace change or sign-out", async ({
  page,
}) => {
  await create(page);
  await upload(
    page,
    "Current",
    "old.pdf",
    readFileSync(
      "tests/fixtures/catalogue-benchmark/synthetic/old-catalogue.pdf",
    ),
  );
  await worker();
  await expect(
    page.getByRole("heading", { name: "Digital-table candidate", exact: true }),
  ).toBeVisible();
  const url = page.url();
  for (const action of ["file", "workspace", "signout"]) {
    await page.goto("/#/comparisons");
    let release!: () => void, received!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      received = r;
    });
    await page.route("**/api/pdf", async (route) => {
      const response = await route.fetch();
      received();
      await hold;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(url);
    await started;
    if (action === "file") {
      await page
        .getByRole("link", { name: "← Comparisons", exact: true })
        .click();
      await create(page);
    } else if (action === "workspace")
      await page.getByLabel("Workspace", { exact: true }).selectOption(other);
    else
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
    release();
    await page.unroute("**/api/pdf");
    await expect(page.locator(".pdf-settings")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: "Digital-table candidate",
        exact: true,
      }),
    ).toHaveCount(0);
    if (action === "workspace") {
      await page.getByLabel("Workspace", { exact: true }).selectOption(tenant);
    }
  }
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await noProducts();
});

test("explicit digital extraction, correction draft and confirmation survive return without starting comparison", async ({
  page,
}, info) => {
  await create(page);
  const bytes = Buffer.from(
    execFileSync(python, ["services/worker/tests/pdf_fixture.py"], {
      env,
      encoding: "utf8",
    }).trim(),
    "base64",
  );
  const area = await upload(page, "Current", "digital.pdf", bytes);
  await worker();
  await expect(
    area.getByRole("heading", { name: "Digital-table candidate", exact: true }),
  ).toBeVisible();
  await expect(area.getByLabel("Last page")).toHaveValue("2");
  await noProducts();
  await area.getByRole("button", { name: "Extract selected pages" }).click();
  await expect(
    area.getByText("PDF extraction queued", { exact: false }),
  ).toBeVisible();
  await worker();
  await expect(
    area.getByRole("heading", { name: "Original values and corrections" }),
  ).toBeVisible();
  for (const [field, column] of [
    ["SKU header", "SKU"],
    ["Cost header", "Price"],
    ["Description header", "Description"],
    ["Currency column", "Currency"],
    ["Pack quantity column", "Pack"],
    ["Unit column", "UOM"],
  ])
    await area.getByLabel(field!, { exact: true }).selectOption(column!);
  await area
    .getByLabel("Correct cost_price page 1 row 3", { exact: true })
    .fill("2.00");
  await expect(
    area.getByRole("button", { name: "Confirm PDF mapping" }),
  ).toBeDisabled();
  await area.getByRole("button", { name: "Save correction draft" }).click();
  await expect(
    area.getByText("Correction draft saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    area.getByLabel("Correct cost_price page 1 row 3", { exact: true }),
  ).toHaveValue("2.00");
  await expect(
    page.getByRole("button", { name: "Start comparison" }),
  ).toBeDisabled();
  await area
    .getByLabel("I checked the selected table", { exact: false })
    .check();
  await area.getByRole("button", { name: "Confirm PDF mapping" }).click();
  await expect(
    area.getByText("PDF mapping confirmed. Ready for comparison.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(area.getByText(/Revision 2 · confirmed/)).toBeVisible();
  expect(
    Number(
      (
        await db.query(
          "select count(*) n from public.extraction_runs where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
    ),
  ).toBe(1);
  expect(
    Number(
      (
        await db.query(
          "select count(*) n from public.comparison_runs where tenant_id=$1",
          [tenant],
        )
      ).rows[0].n,
    ),
  ).toBe(0);
  await screenshot(page, info.project.name, "explicit-gates");
});
