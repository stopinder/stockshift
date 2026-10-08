import assert from "node:assert/strict";
import { test } from "node:test";
import {
  digitalPageRange,
  inspectionLabel,
  inspectionPending,
} from "../src/pdf-inspection";
import type { PdfInspectionState } from "../src/pdf-inspection";
const candidate: PdfInspectionState = {
  fileId: "file",
  byteVerification: "verified",
  inspection: {
    id: "inspection",
    status: "inspected",
    pageCount: 2,
    diagnostics: [
      {
        page: 1,
        state: "digital_candidate",
        code: "ruled_table_candidate",
        table_count: 1,
      },
      {
        page: 2,
        state: "ocr_required",
        code: "no_usable_embedded_table",
        table_count: 0,
      },
    ],
    failure: null,
  },
  comparisonEligibility: "requires_confirmed_extraction",
};
test("digital extraction requires verified persisted candidate pages, not merely a page count", () => {
  assert.equal(digitalPageRange(candidate, 1, 1), true);
  for (const range of [
    [1, 2],
    [0, 1],
    [2, 1],
    [1, 3],
    [1.5, 2],
  ])
    assert.equal(digitalPageRange(candidate, range[0]!, range[1]!), false);
  assert.equal(
    digitalPageRange({ ...candidate, byteVerification: "verifying" }, 1, 1),
    false,
  );
  assert.equal(
    digitalPageRange(
      {
        ...candidate,
        inspection: { ...candidate.inspection, status: "queued" },
      },
      1,
      1,
    ),
    false,
  );
  assert.equal(
    digitalPageRange(
      {
        ...candidate,
        inspection: { ...candidate.inspection, diagnostics: null },
      },
      1,
      1,
    ),
    false,
  );
  assert.equal(
    candidate.comparisonEligibility,
    "requires_confirmed_extraction",
  );
});
test("polling is limited to pending verification or queued/running inspection", () => {
  assert.equal(inspectionPending(null), false);
  for (const status of [
    "not_queued",
    "inspected",
    "ocr_required",
    "failed",
  ] as const)
    assert.equal(
      inspectionPending({
        ...candidate,
        inspection: { ...candidate.inspection, status },
      }),
      false,
    );
  for (const status of ["queued", "running"] as const)
    assert.equal(
      inspectionPending({
        ...candidate,
        inspection: { ...candidate.inspection, status },
      }),
      true,
    );
  assert.equal(
    inspectionPending({ ...candidate, byteVerification: "verifying" }),
    true,
  );
  assert.equal(
    inspectionPending({ ...candidate, byteVerification: "pending" }),
    false,
  );
});
test("inspection labels distinguish byte verification, candidates, OCR and failures", () => {
  assert.equal(inspectionLabel(candidate), "Digital-table candidate");
  assert.equal(
    inspectionLabel({ ...candidate, byteVerification: "failed" }),
    "Upload verification failed",
  );
  assert.equal(
    inspectionLabel({
      ...candidate,
      inspection: { ...candidate.inspection, status: "ocr_required" },
    }),
    "OCR required",
  );
  assert.equal(
    inspectionLabel({
      ...candidate,
      inspection: { ...candidate.inspection, status: "failed" },
    }),
    "PDF inspection failed",
  );
});
