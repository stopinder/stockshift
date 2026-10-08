import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkspaceCreationStatus,
  workspaceCreationError,
} from "../src/workspaces.ts";
import { parseAllowance, canStartDraft, canCompare } from "../src/allowance.ts";
test("workspace availability and cap must come from a valid server response", () => {
  assert.equal(
    parseWorkspaceCreationStatus({
      owned_count: 2,
      workspace_limit: 3,
      trial_available: false,
    }).owned_count,
    2,
  );
  for (const value of [
    null,
    {},
    { owned_count: -1, workspace_limit: 3, trial_available: true },
    { owned_count: 0, workspace_limit: 999, trial_available: true },
    { owned_count: 0, workspace_limit: 3, trial_available: "yes" },
  ])
    assert.throws(() => parseWorkspaceCreationStatus(value));
  assert.match(workspaceCreationError({ code: "P0001" }), /three owned/);
  assert.match(workspaceCreationError({ code: "42501" }), /Confirm your email/);
  assert.match(workspaceCreationError({}), /same request/);
});
test("subscription-required workspace cannot start drafts or comparisons, including test workspaces", () => {
  const quota = {
    plan: "subscription_required",
    comparisons_remaining: 0,
    comparison_limit: 20,
    uploads_remaining: 0,
    upload_limit: 200,
    bytes_remaining: 0,
    byte_limit: 524288000,
    period_end: null,
    test_workspace: true,
  };
  const a = parseAllowance(quota);
  assert.equal(canStartDraft(a), false);
  assert.equal(canCompare(a), false);
  assert.throws(() => parseAllowance({ ...quota, comparisons_remaining: 3 }));
  assert.throws(() => parseAllowance({ ...quota, test_workspace: undefined }));
});
