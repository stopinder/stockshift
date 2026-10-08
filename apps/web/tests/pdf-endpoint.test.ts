import assert from "node:assert/strict";
import test from "node:test";
import handler from "../api/pdf";
process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED = "1";

async function request(method: string, body: unknown, authorization?: string) {
  const headers: Record<string, string | number | readonly string[]> = {};
  const res = {
    statusCode: 0,
    output: "",
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name] = value;
    },
    end(value: string) {
      this.output = value;
    },
  };
  await handler(
    {
      method,
      body,
      headers: authorization ? { authorization } : {},
    } as Parameters<typeof handler>[0],
    res as unknown as Parameters<typeof handler>[1],
  );
  return { ...res, headers };
}
test("PDF inspection requires POST and sends no-store", async () => {
  const result = await request("GET", {});
  assert.equal(result.statusCode, 405);
  assert.equal(result.headers.Allow, "POST");
  assert.equal(result.headers["Cache-Control"], "no-store");
});
test("PDF inspection rejects missing authentication before local configuration", async () => {
  assert.equal((await request("POST", {})).statusCode, 401);
});
test("PDF inspection rejects malformed IDs and request-supplied paths/settings", async () => {
  const input = {
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  };
  for (const body of [
    null,
    [],
    { ...input, objectPath: "../other" },
    { ...input, fileId: "wrong" },
    { ...input, headerRow: 201 },
    { ...input, headerRow: 1.5 },
    { ...input, worksheet: [] },
  ]) {
    const response = await request("POST", body, "Bearer synthetic-token");
    assert.equal(response.statusCode, 400);
    assert.ok(!response.output.includes("synthetic-token"));
  }
});
