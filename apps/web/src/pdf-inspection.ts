export interface PdfInspectionState {
  fileId: string;
  byteVerification: "pending" | "verifying" | "verified" | "failed";
  inspection: {
    id: string | null;
    status:
      | "not_queued"
      | "queued"
      | "running"
      | "inspected"
      | "ocr_required"
      | "failed";
    pageCount: number | null;
    diagnostics:
      | { page: number; state: string; code: string; table_count: number }[]
      | null;
    failure: { message?: string; code?: string } | null;
  };
  comparisonEligibility: "requires_confirmed_extraction";
}
export function inspectionPending(state: PdfInspectionState | null): boolean {
  return (
    !!state &&
    (state.byteVerification === "verifying" ||
      ["queued", "running"].includes(state.inspection.status))
  );
}
export function digitalPageRange(
  state: PdfInspectionState | null,
  first: number,
  last: number,
): boolean {
  if (
    !state ||
    state.byteVerification !== "verified" ||
    !["inspected", "ocr_required"].includes(state.inspection.status) ||
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last < first ||
    last > (state.inspection.pageCount ?? 0) ||
    last - first >= 50
  )
    return false;
  const candidates = new Set(
    state.inspection.diagnostics
      ?.filter((p) => p.state === "digital_candidate")
      .map((p) => p.page),
  );
  for (let page = first; page <= last; page++)
    if (!candidates.has(page)) return false;
  return true;
}
export function inspectionLabel(state: PdfInspectionState | null): string {
  if (!state) return "Loading PDF inspection…";
  if (state.byteVerification !== "verified")
    return state.byteVerification === "failed"
      ? "Upload verification failed"
      : "Upload verification pending";
  return {
    not_queued: "Inspection not queued",
    queued: "PDF inspection queued",
    running: "PDF inspection running",
    inspected: "Digital-table candidate",
    ocr_required: "OCR required",
    failed: "PDF inspection failed",
  }[state.inspection.status];
}
