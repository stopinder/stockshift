import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csvOptions,
  importOptions,
  defaultSettings,
  friendlyError,
  validateBrowserConfig,
} from "../src/workflow";
import { changedProductsCsv, EXPORT_COLUMNS } from "../server/export";
const settings = () => ({
  ...defaultSettings(),
  currency: "GBP",
  unit: "each",
});
test("CSV options remain unchanged through structured import routing", () => {
  assert.deepEqual(
    importOptions(settings(), "old.csv"),
    csvOptions(settings()),
  );
});
test("XLSX settings require explicit sheet and header row", () => {
  assert.throws(() => importOptions(settings(), "book.xlsx"), /worksheet/);
  assert.throws(
    () =>
      importOptions(
        { ...settings(), worksheet: "Products", headerRow: 201 },
        "book.xlsx",
      ),
    /header/,
  );
});
test("mapped XLSX commercial fields require no invented file-wide defaults", () => {
  const options = importOptions(
    {
      ...defaultSettings(),
      worksheet: "Products",
      headerRow: 2,
      currencyColumn: "Currency",
      unitColumn: "UOM",
      packColumn: "Pack",
    },
    "a.xlsx",
  );
  assert.equal(options.currency, null);
  assert.equal(options.unit, null);
  assert.equal(options.pack_quantity, null);
});
test("XLSX optional fields use explicit distinct column mappings", () => {
  const options = importOptions(
    {
      ...settings(),
      worksheet: "Products",
      headerRow: 2,
      currencyColumn: "Currency",
      packColumn: "Pack",
      unitColumn: "UOM",
    },
    "book.xlsx",
  );
  assert.equal((options as { format: string }).format, "xlsx");
  assert.deepEqual(options.columns, {
    supplier_sku: "SKU",
    cost_price: "Price",
    description: "Description",
    currency: "Currency",
    pack_quantity: "Pack",
    unit: "UOM",
  });
  assert.throws(
    () =>
      importOptions(
        {
          ...settings(),
          worksheet: "Products",
          headerRow: 2,
          currencyColumn: "SKU",
        },
        "book.xlsx",
      ),
    /different/,
  );
});
test("explicit CSV settings retain header strings and canonical defaults", () => {
  const options = csvOptions(settings());
  assert.equal(options.columns.supplier_sku, "SKU");
  assert.equal(options.pack_quantity, "1");
  assert.equal(options.encoding, "utf-8-sig");
  assert.equal(options.tax_basis, "net");
});
test("CSV settings require currency and units rather than guessing", () => {
  assert.throws(() => csvOptions(defaultSettings()), /currency/);
});
test("CSV settings reject ambiguous number conventions and duplicate mappings", () => {
  assert.throws(
    () => csvOptions({ ...settings(), thousands: "." }),
    /separators/,
  );
  assert.throws(() => csvOptions({ ...settings(), price: "SKU" }), /distinct/);
});
test("CSV settings support explicitly configured decimal commas", () => {
  const result = csvOptions({
    ...settings(),
    decimal: ",",
    delimiter: ";",
    thousands: ".",
  });
  assert.equal(result.decimal_separator, ",");
  assert.equal(result.thousands_separator, ".");
});
test("CSV export preserves leading zeros, precision and undefined percentage", () => {
  const csv = changedProductsCsv([
    {
      supplier_sku: "000012",
      old_cost: "0.0000",
      new_cost: "1.2500",
      cost_delta: "1.2500",
      cost_change_percent: null,
      percentage_state: "zero_old_cost",
    },
  ]);
  assert.ok(csv.startsWith(EXPORT_COLUMNS.join(",") + "\r\n"));
  assert.ok(csv.includes('"000012"'));
  assert.ok(csv.includes('"0.0000","1.2500","1.2500","","zero_old_cost"'));
});
for (const attack of [
  "=SUM(1,2)",
  "+cmd",
  "-cmd",
  "@cmd",
  " \t=cmd",
  "\ufeff@cmd",
  "\tvalue",
  "\rvalue",
]) {
  test(`CSV neutralises formula prefix ${JSON.stringify(attack)}`, () => {
    const csv = changedProductsCsv([
      { supplier_sku: attack, description: attack },
    ]);
    assert.ok(csv.includes(`"'${attack}"`));
  });
}
test("CSV keeps negative numeric deltas numeric and escapes quoted multiline text", () => {
  const csv = changedProductsCsv([
    {
      supplier_sku: "01",
      description: 'A "quoted"\nproduct',
      cost_delta: "-0.0001",
    },
  ]);
  assert.ok(csv.includes('"-0.0001"'));
  assert.ok(!csv.includes("'-0.0001"));
  assert.ok(csv.includes('"A ""quoted""\nproduct"'));
});
test("CSV rejects noncanonical persisted decimal values", () => {
  assert.throws(() => changedProductsCsv([{ new_cost: "=cmd" }]), /decimal/);
});
test("empty export has deterministic header only", () => {
  assert.equal(changedProductsCsv([]), EXPORT_COLUMNS.join(",") + "\r\n");
});
test("browser configuration refuses hosted URLs and secret keys", () => {
  assert.throws(() =>
    validateBrowserConfig("https://example.supabase.co", "sb_publishable_test"),
  );
  assert.throws(() =>
    validateBrowserConfig("http://127.0.0.1:54321", "sb_secret_test"),
  );
  const jwt = `a.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.b`;
  assert.throws(() => validateBrowserConfig("http://127.0.0.1:54321", jwt));
  assert.equal(
    validateBrowserConfig("http://127.0.0.1:54321", "sb_publishable_test").url,
    "http://127.0.0.1:54321",
  );
});
test("permission and session errors stay actionable and omit database details", () => {
  assert.match(friendlyError({ code: "42501", message: "secret" }), /access/);
  assert.match(
    friendlyError({ code: "PGRST301", message: "secret" }),
    /expired/,
  );
  assert.ok(!friendlyError({ message: "secret" }).includes("secret"));
});
