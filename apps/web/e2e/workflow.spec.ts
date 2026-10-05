import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";

// Explicit loopback only. No .env loading or hosted credential fallback.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_)/i.test(key),
  ),
);
const state = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/supabase-local.mjs", "status", "--output", "json"],
    { env, encoding: "utf8" },
  ),
);
if (state.API_URL !== "http://127.0.0.1:54321")
  throw new Error("Local stack required");
const admin = createClient(state.API_URL, state.SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
let account: { email: string; password: string; tenant: string };
test.beforeEach(async ({ page }) => {
  account = {
    email: `browser-${randomUUID()}@stockshift.local`,
    password: randomUUID(),
    tenant: randomUUID(),
  };
  const created = await admin.auth.admin.createUser({
    email: account.email,
    password: account.password,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const db = new Client({
    host: "127.0.0.1",
    port: 54322,
    user: "postgres",
    password: "postgres",
    database: "postgres",
    ssl: false,
  });
  await db.connect();
  try {
    await db.query("insert into public.tenants(id,name) values($1,$2)", [
      account.tenant,
      "Northline Supply",
    ]);
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
      [account.tenant, created.data.user!.id],
    );
  } finally {
    await db.end();
  }
  await page.goto("/#/login");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Comparisons", exact: true }),
  ).toBeVisible();
});
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
async function create(page: Page, title: string) {
  await page.getByRole("link", { name: "+ New comparison" }).click();
  await page.getByLabel("Comparison name").fill(title);
  await page.getByLabel("Supplier", { exact: true }).selectOption("new");
  await page.getByLabel("Supplier name").fill("Northline Components");
  await page.getByRole("button", { name: "Continue to files" }).click();
  await expect(
    page.getByRole("heading", { name: "Add your CSV files" }),
  ).toBeVisible();
  await noOverflow(page);
}
async function upload(page: Page, old: Buffer, next: Buffer) {
  await page
    .getByLabel("Current CSV file")
    .setInputFiles({ name: "current.csv", mimeType: "text/csv", buffer: old });
  await expect(page.getByText("✓ Verified and ready")).toHaveCount(1);
  await page.getByLabel("New CSV file").setInputFiles({
    name: "supplier.csv",
    mimeType: "text/csv",
    buffer: next,
  });
  await expect(page.getByText("✓ Verified and ready")).toHaveCount(2);
  for (const group of [
    "CSV settings · current catalogue",
    "CSV settings · new catalogue",
  ]) {
    const fieldset = page.getByRole("group", { name: group });
    await fieldset.getByLabel("Currency", { exact: true }).fill("GBP");
    await fieldset.getByLabel("Unit", { exact: true }).fill("each");
  }
}
function worker() {
  const python = resolve(
    "services/worker/.venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const result = spawnSync(
    python,
    ["-m", "stockshift_worker.entrypoints.cli", "--once"],
    {
      env: {
        ...env,
        STOCKSHIFT_LOCAL_SUPABASE_URL: state.API_URL,
        STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: state.SERVICE_ROLE_KEY,
      },
      encoding: "utf8",
      timeout: 60000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
}
test("authenticated upload → durable processing → review → trusted export survives reload", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByText("Your first comparison starts here"),
  ).toBeVisible();
  await create(page, "October price review");
  await upload(
    page,
    readFileSync("tests/fixtures/csv/old_catalogue.csv"),
    readFileSync("tests/fixtures/csv/new_supplier_catalogue.csv"),
  );
  await page.reload();
  await expect(page.getByText("current.csv", { exact: true })).toBeVisible();
  for (const group of [
    "CSV settings · current catalogue",
    "CSV settings · new catalogue",
  ]) {
    await page
      .getByRole("group", { name: group })
      .getByLabel("Currency", { exact: true })
      .fill("GBP");
    await page
      .getByRole("group", { name: group })
      .getByLabel("Unit", { exact: true })
      .fill("each");
  }
  await page.getByRole("button", { name: "Start comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison queued" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Comparison queued" }),
  ).toBeVisible();
  await page.screenshot({
    path: `.tools/${info.project.name}-queued.png`,
    fullPage: true,
  });
  // Hold a real lease long enough to inspect the running state, then recover it locally.
  const held = await admin.rpc("claim_csv_job", { p_worker: randomUUID() });
  expect(held.error).toBeNull();
  expect(held.data.tenant_id).toBe(account.tenant);
  await expect(
    page.getByRole("heading", { name: "Comparing your catalogues" }),
  ).toBeVisible({ timeout: 15000 });
  await page.screenshot({
    path: `.tools/${info.project.name}-running.png`,
    fullPage: true,
  });
  const leaseDb = new Client({
    host: "127.0.0.1",
    port: 54322,
    user: "postgres",
    password: "postgres",
    database: "postgres",
    ssl: false,
  });
  await leaseDb.connect();
  try {
    await leaseDb.query(
      "update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [held.data.id],
    );
  } finally {
    await leaseDb.end();
  }
  worker();
  await expect(
    page.getByRole("region", { name: "Persisted outcome counts" }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("button", { name: "↓ Export changed products" }),
  ).toBeDisabled();
  await page.getByLabel("Outcome", { exact: true }).selectOption("changed");
  await expect(page.locator(".results-table tbody tr")).toHaveCount(30);
  await page.getByLabel("Search SKU or description").fill("000051");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".results-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".product-cell strong")).toHaveText("000051");
  await page.getByLabel("Search SKU or description").fill("");
  await page
    .getByLabel("Outcome", { exact: true })
    .selectOption("needs_review");
  await expect(page.locator(".results-table tbody tr")).toHaveCount(2);
  await page.screenshot({
    path: `.tools/${info.project.name}-review.png`,
    fullPage: true,
  });
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "Review", exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("No paired record")).toBeVisible();
    await page.getByText(/Field provenance \(/).click();
    await expect(page.locator("dialog .evidence-table")).toBeVisible();
    const sourceName = (
      await page.locator("dialog .record-grid").innerText()
    ).includes("Unidentified old fitting")
      ? "current.csv"
      : "supplier.csv";
    await expect(page.locator("dialog .evidence-table")).toContainText(
      sourceName,
    );
    await expect(page.locator("dialog .evidence-table tbody tr")).toHaveCount(
      3,
    );
    await page
      .getByLabel("Decision reason")
      .fill("No safe identifier; exclude this record from the update.");
    await page.screenshot({ path: `.tools/${info.project.name}-evidence.png` });
    await page
      .getByRole("button", { name: "Confirm no match · exclude" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(1 - i);
  }
  await page.reload();
  await expect(
    page.getByText("2 review item(s) explicitly excluded.", { exact: false }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "↓ Export changed products" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("changed_products.csv");
  const csv = readFileSync((await download.path())!, "utf8");
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(31);
  expect(csv).toContain('"000051"');
  expect(csv).not.toContain('"needs_review"');
  await page.screenshot({
    path: `.tools/${info.project.name}-complete.png`,
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  await noOverflow(page);
  expect(errors).toEqual([]);
});
test("invalid CSV mapping persists an actionable failure", async ({ page }) => {
  await create(page, "Invalid headers");
  await upload(
    page,
    Buffer.from("SKU,Price,Description\n01,1,A\n"),
    Buffer.from("Wrong,Price,Description\n01,2,A\n"),
  );
  await page.getByRole("button", { name: "Start comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison queued" }),
  ).toBeVisible();
  worker();
  await expect(
    page.getByRole("heading", { name: "Comparison could not finish" }),
  ).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(page.getByText(/Check the CSV headers/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "↓ Export changed products" }),
  ).toBeDisabled();
  await noOverflow(page);
});
test("empty CSV result and header-only export are clear", async ({ page }) => {
  await create(page, "Header-only files");
  await upload(
    page,
    Buffer.from("SKU,Price,Description\n"),
    Buffer.from("SKU,Price,Description\n"),
  );
  await page.getByRole("button", { name: "Start comparison" }).click();
  await expect(
    page.getByRole("heading", { name: "Comparison queued" }),
  ).toBeVisible();
  worker();
  await expect(
    page.getByText("No product rows were found in these CSV files."),
  ).toBeVisible({ timeout: 15000 });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "↓ Export changed products" }).click();
  const csv = readFileSync((await (await downloaded).path())!, "utf8");
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  await noOverflow(page);
});
test("upload verification failure can be retried and invalid settings are actionable", async ({
  page,
}) => {
  await create(page, "Retry upload");
  await page.getByLabel("Current CSV file").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("%PDF-1.7\n"),
  });
  await expect(
    page.getByText("Upload is not supported CSV text"),
  ).toBeVisible();
  await upload(
    page,
    Buffer.from("SKU,Price,Description\n01,1,A\n"),
    Buffer.from("SKU,Price,Description\n01,2,A\n"),
  );
  await page
    .getByRole("group", { name: "CSV settings · current catalogue" })
    .getByLabel("Cost header")
    .fill("SKU");
  await page.getByRole("button", { name: "Start comparison" }).click();
  await expect(
    page.getByText(/Use distinct, exact CSV column headers/),
  ).toBeVisible();
  await noOverflow(page);
});
test("unavailable tenant comparison and invalid session do not leak data", async ({
  page,
}) => {
  await page.goto(`/#/comparisons/${randomUUID()}`);
  await expect(page.getByText(/Comparison unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(/Sign-in failed/)).toBeVisible();
  await noOverflow(page);
});
