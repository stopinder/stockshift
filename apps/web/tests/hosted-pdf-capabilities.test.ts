import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedPdfCapabilities } from "../src/pdf-capabilities";
import { csvPreviewOnly, requireSupportedUpload } from "../server/uploads";
import { validateDeploymentConfig } from "../server/supabase-upload-gateway";

const hosted = {
  VERCEL: "1",
  STOCKSHIFT_SUPABASE_MODE: "hosted",
  STOCKSHIFT_SUPABASE_URL: "https://cpu-fixture.supabase.co",
  STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  STOCKSHIFT_SUPABASE_SECRET_KEY: "sb_secret_fixture",
  VITE_STOCKSHIFT_SUPABASE_MODE: "hosted",
  VITE_STOCKSHIFT_SUPABASE_URL: "https://cpu-fixture.supabase.co",
  VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
};
test("hosted capabilities default off; independent inspection and extraction require valid combinations", () => {
  assert.deepEqual(hostedPdfCapabilities({}), {
    inspection: false,
    extraction: false,
  });
  for (const inspection of ["0", "1"])
    for (const extraction of ["0", "1"]) {
      const flags = {
        STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: inspection,
        STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: extraction,
      };
      if (inspection === "0" && extraction === "1")
        assert.throws(() => hostedPdfCapabilities(flags));
      else
        assert.deepEqual(hostedPdfCapabilities(flags), {
          inspection: inspection === "1",
          extraction: extraction === "1",
        });
    }
  for (const invalid of ["true", "yes", "2"])
    assert.throws(() =>
      hostedPdfCapabilities({
        STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: invalid,
      }),
    );
  assert.throws(() =>
    hostedPdfCapabilities({
      STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: "1",
      STOCKSHIFT_CSV_ONLY: "1",
    }),
  );
  assert.throws(() =>
    hostedPdfCapabilities({
      STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: "1",
      STOCKSHIFT_OCR_ENABLED: "1",
    }),
  );
});
test("browser/API capabilities must match exactly at deployment validation", () => {
  validateDeploymentConfig(hosted);
  for (const extraction of ["0", "1"]) {
    const flags = {
      STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: "1",
      STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: extraction,
    };
    assert.throws(
      () => validateDeploymentConfig({ ...hosted, ...flags }),
      /capabilities must agree/,
    );
    validateDeploymentConfig({
      ...hosted,
      ...flags,
      VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: "1",
      VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: extraction,
    });
  }
});
test("inspection capability permits hosted PDFs only; local opt-in never enables hosted processing or XLSX", () => {
  const saved = { ...process.env };
  try {
    process.env.STOCKSHIFT_SUPABASE_MODE = "hosted";
    process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED = "1";
    delete process.env.STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED;
    delete process.env.STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED;
    assert.equal(csvPreviewOnly(process.env), true);
    assert.throws(() => requireSupportedUpload("file.pdf"));
    requireSupportedUpload("file.csv");
    process.env.STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED = "1";
    assert.equal(csvPreviewOnly(process.env), false);
    requireSupportedUpload("file.pdf");
    assert.throws(() => requireSupportedUpload("file.xlsx"));
  } finally {
    process.env = saved;
  }
});
