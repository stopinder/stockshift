import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csvOptions,
  defaultSettings,
  savedImportSettings,
} from "../src/workflow.ts";

test("numeric quantities cannot be entered as a file-wide unit", () => {
  for (const unit of ["1", " 1 ", "12", "1.5", "1,5", ".5", "-1", "1e3"])
    assert.throws(
      () => csvOptions({ ...defaultSettings(), currency: "GBP", unit }),
      /Unit means how the product is sold/,
    );
});
test("unit names and codes are preserved alongside a separate pack quantity", () => {
  for (const unit of ["each", "box", "kg", "m²", "C62", "1 m"]) {
    const result = csvOptions({ ...defaultSettings(), currency: "GBP", unit });
    assert.equal(result.unit, unit);
    assert.equal(result.pack_quantity, "1");
  }
  assert.equal(
    csvOptions({ ...defaultSettings(), currency: "GBP", unit: "1" }, ["unit"])
      .unit,
    null,
  );
});
test("saved settings expose each side independently without correcting historical values", () => {
  const rows = savedImportSettings({
    current: {
      unit: "1",
      pack_quantity: "1",
      currency: "GBP",
      thousands_separator: null,
    },
    incoming: {
      unit: "each",
      pack_quantity: "6",
      currency: "EUR",
      delimiter: "\t",
    },
  });
  assert.deepEqual(
    rows.find((row) => row.label === "Unit of measure"),
    { label: "Unit of measure", current: "1", incoming: "each" },
  );
  assert.deepEqual(
    rows.find((row) => row.label === "Pack quantity"),
    { label: "Pack quantity", current: "1", incoming: "6" },
  );
  assert.equal(
    rows.find((row) => row.label === "Thousands separator")?.current,
    "None",
  );
  assert.equal(rows.find((row) => row.label === "Delimiter")?.incoming, "Tab");
  assert.equal(
    savedImportSettings({}).find((row) => row.label === "Unit of measure")
      ?.current,
    "Not set",
  );
});
