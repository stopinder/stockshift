import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvPreviewOnly,
  parseIntent,
  verifyCsv,
  finalizeUpload,
} from "../server/uploads.ts";
import pdf from "../api/pdf.ts";
import workbook from "../api/workbook.ts";

const id = "11111111-1111-4111-8111-111111111111";
test("hosted preview is CSV only; local formats remain available", () => {
  assert.equal(csvPreviewOnly({ STOCKSHIFT_SUPABASE_MODE: "hosted" }), true);
  assert.equal(csvPreviewOnly({ VERCEL: "1" }), true);
  assert.equal(csvPreviewOnly({ STOCKSHIFT_SUPABASE_MODE: "local" }), false);
});
test("CSV preview rejects unsupported uploads and inspections before Python/network", async () => {
  const previous = process.env.STOCKSHIFT_CSV_ONLY;
  process.env.STOCKSHIFT_CSV_ONLY = "1";
  try {
    for (const filename of ["supplier.xlsx", "supplier.pdf"])
      assert.throws(
        () => parseIntent({ tenantId: id, filename, byteCount: 100 }),
        /CSV only/,
      );
    assert.equal(
      parseIntent({ tenantId: id, filename: "supplier.csv", byteCount: 100 })
        .filename,
      "supplier.csv",
    );
    const gateway = {
      authenticate: async () => id,
      membership: async () => "owner" as const,
      transition: async () => ({
        id,
        tenant_id: id,
        created_by: id,
        original_filename: "already-ready.pdf",
        bucket_id: "catalogue-uploads",
        object_name: id + "/" + id + "/original",
        expected_byte_count: 100,
        status: "ready" as const,
        byte_count: 100,
        verified_mime: "application/pdf",
        sha256: "a".repeat(64),
      }),
      download: async () => {
        throw new Error("must not inspect unsupported source");
      },
      createIntent: async () => {
        throw new Error("unused");
      },
      signUpload: async () => {
        throw new Error("unused");
      },
    };
    await assert.rejects(
      finalizeUpload(gateway, "test-session", { tenantId: id, fileId: id }),
      /CSV only/,
    );
    for (const handler of [pdf, workbook]) {
      const response = {
        statusCode: 0,
        body: "",
        setHeader() {},
        end(body: string) {
          this.body = body;
        },
      };
      await handler({ method: "POST", headers: {} } as any, response as any);
      assert.equal(response.statusCode, 422);
      assert.match(response.body, /CSV only/);
    }
    assert.equal(
      verifyCsv(Buffer.from("SKU,Price\n001,19.995\n")).mime,
      "text/csv",
    );
  } finally {
    if (previous === undefined) delete process.env.STOCKSHIFT_CSV_ONLY;
    else process.env.STOCKSHIFT_CSV_ONLY = previous;
  }
});
