import assert from "node:assert/strict";
import { test } from "node:test";
import { apiErrorMessage } from "../src/workflow.ts";

test("API errors preserve actionable JSON errors", async () => {
  assert.equal(await apiErrorMessage(Response.json({ error: "Editor membership required" }, { status: 403 })), "Editor membership required");
});
test("plain-text platform crashes expose status and code", async () => {
  const response = new Response("A server error occurred\nFUNCTION_INVOCATION_FAILED\nrequest-id: private", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  assert.equal(await apiErrorMessage(response), "Request failed (HTTP 500: FUNCTION_INVOCATION_FAILED).");
});
test("HTML, arbitrary plain text and malformed JSON stay bounded and private", async () => {
  for (const [type, body] of [["text/html", "<h1>secret detail</h1>"], ["text/plain", "sb_secret_do_not_display"], ["application/json", "invalid"], ["application/json", '{"error":{"secret":"private"}}']]) {
    assert.equal(await apiErrorMessage(new Response(body, { status: 503, headers: { "content-type": type! } })), "Request failed (HTTP 503). Try again.");
  }
});
test("structured JSON media types remain supported", async () => {
  assert.equal(await apiErrorMessage(new Response('{"error":"Use CSV only"}', { status: 422, headers: { "content-type": "application/problem+json" } })), "Use CSV only");
});
