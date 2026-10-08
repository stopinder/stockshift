import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowance,
  canCompare,
  canUpload,
  canStartDraft,
} from "../src/allowance";
const trial = {
  plan: "trial",
  comparisons_remaining: 3,
  comparison_limit: 3,
  uploads_remaining: 20,
  upload_limit: 20,
  bytes_remaining: 104857600,
  byte_limit: 104857600,
  period_end: null,
};
test("trial preflight respects comparisons, individual file size and two-file draft needs", () => {
  const a = parseAllowance(trial);
  assert.equal(canStartDraft(a), true);
  assert.equal(canUpload(a, 104857601), false);
  assert.equal(canCompare({ ...a, comparisons_remaining: 0 }), false);
  assert.equal(canUpload({ ...a, comparisons_remaining: 0 }), false);
  assert.equal(canStartDraft({ ...a, uploads_remaining: 1 }), false);
  assert.equal(canUpload({ ...a, uploads_remaining: 1 }), true);
  assert.equal(
    canCompare({ ...a, uploads_remaining: 0, bytes_remaining: 0 }),
    true,
  );
  assert.equal(canStartDraft(null), false);
});
test("missing and malformed quota responses fail closed", () => {
  for (const value of [
    null,
    {},
    { ...trial, plan: "unknown" },
    { ...trial, comparisons_remaining: -1 },
    { ...trial, comparisons_remaining: 4 },
    { ...trial, uploads_remaining: null },
    { ...trial, bytes_remaining: NaN },
    { ...trial, period_end: "not a date" },
    { ...trial, plan: "paid", period_end: null },
  ])
    assert.throws(() => parseAllowance(value));
});
test("pilot is explicitly exempt; paid status requires valid period evidence", () => {
  const a = parseAllowance({
    plan: "pilot",
    comparisons_remaining: null,
    comparison_limit: null,
    uploads_remaining: null,
    upload_limit: null,
    bytes_remaining: null,
    byte_limit: null,
    period_end: null,
  });
  assert.equal(canUpload(a, 104857600), true);
  assert.equal(canStartDraft(a), true);
  assert.throws(() => parseAllowance({ ...a, comparisons_remaining: 3 }));
  assert.equal(
    canCompare(
      parseAllowance({
        ...trial,
        plan: "paid",
        period_end: "2026-11-01T00:00:00Z",
      }),
    ),
    true,
  );
});

// Switching workspaces must invalidate pending responses from the previous tenant.
test("late allowance responses cannot cross workspace or logout boundaries", async () => {
  const { effectScope, ref } = await import("vue");
  const { useAllowance } = await import("../src/allowance");
  const requests: { tenant: string; resolve: (value: unknown) => void }[] = [];
  const client = {
    rpc: (_name: string, input: { p_tenant: string }) =>
      new Promise((resolve) =>
        requests.push({ tenant: input.p_tenant, resolve }),
      ),
  };
  const scope = effectScope();
  const tenant = ref("workspace-a");
  const state = scope.run(() => useAllowance(client as never, tenant))!;
  assert.equal(state.canCreate.value, false);
  tenant.value = "workspace-b";
  requests[1]!.resolve({
    data: { ...trial, comparisons_remaining: 0 },
    error: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.value.value?.comparisons_remaining, 0);
  requests[0]!.resolve({ data: trial, error: null });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.value.value?.comparisons_remaining, 0);
  const pending = state.refresh();
  tenant.value = "";
  requests[2]!.resolve({ data: trial, error: null });
  assert.equal(await pending, null);
  assert.equal(state.value.value, null);
  assert.equal(state.loading.value, false);
  scope.stop();
});
test("failed refresh clears a previously usable allowance and retry restores it", async () => {
  const { effectScope, ref } = await import("vue");
  const { useAllowance } = await import("../src/allowance");
  let fails = false;
  const client = {
    rpc: async () =>
      fails
        ? { error: { code: "42501" }, data: null }
        : { error: null, data: trial },
  };
  const scope = effectScope();
  const state = scope.run(() =>
    useAllowance(client as never, ref("workspace")),
  )!;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.canCreate.value, true);
  fails = true;
  assert.equal(await state.refresh(), null);
  assert.equal(state.canCreate.value, false);
  assert.match(state.error.value, /Saved results remain available/);
  fails = false;
  await state.refresh();
  assert.equal(state.error.value, "");
  assert.equal(state.canCreate.value, true);
  scope.stop();
});
