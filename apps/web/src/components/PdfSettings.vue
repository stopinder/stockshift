<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  api,
  csvOptions,
  defaultSettings,
  friendlyError,
  digitalPdfEnabled,
} from "../workflow";
import type { Client, CsvSettings as Settings } from "../workflow";
import CsvSettings from "./CsvSettings.vue";
import {
  digitalPageRange,
  inspectionLabel,
  inspectionPending,
} from "../pdf-inspection";
import type { PdfInspectionState } from "../pdf-inspection";
const props = defineProps<{
  client: Client;
  tenantId: string;
  fileId: string;
  side: string;
}>();
const settings = defineModel<Settings>({ required: true });
type Cell = { column_name: string; value: string | null; evidence_id: string };
type RecordRow = {
  record_id: string;
  raw_cells: Cell[];
  semantic_candidates?: Record<string, string | null>;
};
type Locator = { page: number; table: string; row: number };
type Extraction = {
  id: string;
  status: string;
  configuration: {
    first_page: number;
    last_page: number;
    strategy: string;
    provider?: string;
    model_version?: string;
    layout_association?: { columns: { field: string; label: string }[] };
  };
  completed_pages: number;
  total_pages: number | null;
  failure_reason: { message: string } | null;
  raw_pages:
    | {
        page: number;
        text: string;
        provider?: string;
        confidence?: number | null;
        status?: string;
        message?: string;
      }[]
    | null;
  payload: {
    records: RecordRow[];
    evidence: { evidence_id: string; locator: Locator }[];
    warnings: { code: string; message: string; field?: string | null }[];
  } | null;
};
type Revision = {
  id: string;
  revision: number;
  created_by: string;
  created_at: string;
  confirmed: boolean;
  configuration: ReturnType<typeof configuration>;
  corrections: Record<string, Record<string, string | null>>;
};
const extraction = ref<Extraction | null>(null),
  revision = ref<Revision | null>(null);
const inspection = ref<PdfInspectionState | null>(null);
const canExtract = computed(
  () =>
    digitalPdfEnabled &&
    digitalPageRange(inspection.value, first.value, last.value),
);
const first = ref(1),
  last = ref(1),
  pageCount = ref(0),
  strategy = ref("lines");
const tableIndex = ref(1),
  headerRow = ref(1),
  repeat = ref(true),
  confirmed = ref(false);
const corrections = ref<Record<string, Record<string, string | null>>>({});
const verifiedOcr = ref<string[]>([]);
const ocrIds = computed(
  () =>
    new Set(
      extraction.value?.payload?.warnings
        .filter((w) => w.code === "ocr_verification_required")
        .map((w) => w.field) ?? [],
    ),
);
const hasOcr = computed(() =>
  extraction.value?.raw_pages?.some((p) => p.provider === "paddleocr-vl"),
);
function verifyOcr(id: string, checked: boolean) {
  verifiedOcr.value = checked
    ? [...new Set([...verifiedOcr.value, id])]
    : verifiedOcr.value.filter((v) => v !== id);
  settings.value.pdfRevisionId = undefined;
}
const error = ref(""),
  busy = ref(false),
  notice = ref(""),
  offset = ref(0);
let disposed = false,
  hydrating = false,
  loading = false,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined;
let unsubscribe: (() => void) | undefined;
function active(request: number) {
  return !disposed && request === generation;
}
function schedule() {
  clearTimeout(timer);
  if (
    !disposed &&
    !error.value &&
    (inspectionPending(inspection.value) ||
      ["queued", "running"].includes(extraction.value?.status ?? ""))
  ) {
    timer = setTimeout(() => void refresh(), 1500);
  }
}
const evidence = computed(
  () =>
    new Map(
      extraction.value?.payload?.evidence.map((e) => [
        e.evidence_id,
        e.locator,
      ]) ?? [],
    ),
);
function locator(r: RecordRow): Locator {
  return evidence.value.get(r.raw_cells[0]!.evidence_id)!;
}
const retailGuidance = computed(
  () =>
    extraction.value?.payload?.records.some(
      (r) => r.semantic_candidates?.price_role === "retail_guidance",
    ) ?? false,
);
const unresolvedPricing = computed(
  () =>
    extraction.value?.payload?.records.some(
      (r) => r.semantic_candidates?.pricing_basis_unresolved === "true",
    ) ?? false,
);
const reviewOnly = computed(
  () => retailGuidance.value || unresolvedPricing.value,
);
function sourceAttributes(r: RecordRow) {
  const mapped = new Set(Object.values(mappings.value));
  return r.raw_cells.filter((c) => !mapped.has(c.column_name));
}
function gridTable(r: RecordRow) {
  return r.semantic_candidates?.layout_grid_table ?? locator(r).table;
}
function gridRow(r: RecordRow) {
  return Number(r.semantic_candidates?.layout_grid_row ?? locator(r).row);
}
const tables = computed(() =>
  [
    ...new Set(
      extraction.value?.payload?.records.map((r) => Number(gridTable(r))) ?? [],
    ),
  ].sort((a, b) => a - b),
);
const selected = computed(() =>
  (extraction.value?.payload?.records ?? []).filter(
    (r) => gridTable(r) === String(tableIndex.value),
  ),
);
const firstPage = computed(() =>
  selected.value[0] ? locator(selected.value[0]).page : null,
);
const header = computed(
  () =>
    selected.value.filter((r) => locator(r).page === firstPage.value)[
      headerRow.value - 1
    ],
);
const headers = computed(
  () => header.value?.raw_cells.map((c) => c.value ?? "") ?? [],
);
const productRows = computed(() =>
  selected.value.filter(
    (r) =>
      gridRow(r) > headerRow.value &&
      !(
        repeat.value &&
        r.raw_cells.every((c, i) => (c.value ?? "") === headers.value[i])
      ) &&
      r.raw_cells.some((c) => c.value?.trim()),
  ),
);
const mappings = computed(
  () =>
    (reviewOnly.value
      ? Object.fromEntries(
          (extraction.value?.configuration.layout_association?.columns ?? [])
            .filter((c) =>
              [
                "supplier_sku",
                "description",
                "cost_price",
                "retail_price_ex_vat",
                "retail_price_inc_vat",
              ].includes(c.field),
            )
            .map((c) => [c.field, c.label]),
        )
      : {
          supplier_sku: settings.value.sku,
          cost_price: settings.value.price,
          ...(settings.value.description
            ? { description: settings.value.description }
            : {}),
          ...(settings.value.currencyColumn
            ? { currency: settings.value.currencyColumn }
            : {}),
          ...(settings.value.packColumn
            ? { pack_quantity: settings.value.packColumn }
            : {}),
          ...(settings.value.unitColumn
            ? { unit: settings.value.unitColumn }
            : {}),
        }) as Record<string, string>,
);
function original(r: RecordRow, field: string) {
  return (
    r.raw_cells[headers.value.indexOf(mappings.value[field]!)]?.value ?? null
  );
}
function correct(r: RecordRow, field: string, value: string | null) {
  verifyOcr(r.record_id, false);
  settings.value.pdfRevisionId = undefined;
  notice.value = "Unsaved corrections";
  const entry = (corrections.value[r.record_id] ??= {});
  if (value === "") delete entry[field];
  else entry[field] = value;
  if (!Object.keys(entry).length) delete corrections.value[r.record_id];
}
function configuration() {
  if (
    !reviewOnly.value &&
    (!settings.value.sku ||
      !settings.value.price ||
      settings.value.sku === settings.value.price)
  )
    throw new Error("Map PDF SKU and cost to distinct detected headers.");
  const mappedFields = [
    settings.value.currencyColumn && "currency",
    settings.value.packColumn && "pack_quantity",
    settings.value.unitColumn && "unit",
  ].filter(Boolean) as string[];
  return {
    ...(reviewOnly.value
      ? {
          encoding: "utf-8-sig",
          delimiter: ",",
          decimal_separator: ".",
          thousands_separator: ",",
          currency: "GBP",
          unit: null,
          pack_quantity: null,
          price_basis: null,
          tax_basis: unresolvedPricing.value
            ? (extraction.value?.payload?.records[0]?.semantic_candidates
                ?.tax_basis ?? null)
            : null,
          currency_symbol: "£",
        }
      : csvOptions(settings.value, mappedFields)),
    columns: mappings.value,
    table_index: tableIndex.value,
    header_row: headerRow.value,
    repeat_headers: repeat.value,
    structure_confirmed: confirmed.value,
    ...(ocrIds.value.size ? { ocr_verified_rows: verifiedOcr.value } : {}),
  };
}
function validate() {
  if (
    !headers.value.length ||
    headers.value.some((h) => !h.trim()) ||
    new Set(headers.value).size !== headers.value.length
  )
    throw new Error("Select a table/header with nonblank, unique headers.");
  const cfg = configuration();
  if (
    new Set(Object.values(cfg.columns)).size !==
      Object.keys(cfg.columns).length ||
    !Object.values(cfg.columns).every((h) => headers.value.includes(h))
  )
    throw new Error("Map every field to a different detected column.");
  const pages = new Set(selected.value.map((r) => locator(r).page));
  if (pages.size !== extraction.value?.total_pages)
    throw new Error(
      "Selected table is absent on a page. Extract a smaller page range.",
    );
  for (const page of pages) {
    const h = selected.value.filter((r) => locator(r).page === page)[
      headerRow.value - 1
    ];
    if (
      !h ||
      h.raw_cells.some((c, i) => (c.value ?? "") !== headers.value[i]) ||
      h.raw_cells.length !== headers.value.length
    )
      throw new Error(
        "Headers differ across pages. Extract a smaller page range; rows are never joined across page breaks.",
      );
  }
  if (!productRows.value.length)
    throw new Error("Choose a table containing product rows.");
  const ids = new Set(productRows.value.map((r) => r.record_id));
  for (const [id, fields] of Object.entries(corrections.value)) {
    if (!ids.has(id))
      throw new Error(
        "Corrections refer to unselected rows. Restore the selection or clear corrections.",
      );
    for (const [field, value] of Object.entries(fields)) {
      if (!mappings.value[field])
        throw new Error(
          "Map each corrected field to its original source column.",
        );
      if (
        field === "supplier_sku" &&
        (!value?.trim() || value !== value.trim())
      )
        throw new Error(
          "Corrected SKU must be nonblank with no surrounding spaces.",
        );
      if (field === "currency" && value !== null && !/^[A-Z]{3}$/.test(value))
        throw new Error(
          "Corrected currency must be a three-letter uppercase code.",
        );
      if (
        [
          "cost_price",
          "pack_quantity",
          "retail_price_ex_vat",
          "retail_price_inc_vat",
        ].includes(field) &&
        value !== null
      ) {
        const regex =
          settings.value.decimal === "."
            ? /^[0-9]+(?:\.[0-9]+)?$/
            : /^[0-9]+(?:,[0-9]+)?$/;
        if (
          !regex.test(value) ||
          value.length > 128 ||
          (field === "pack_quantity" && /^0(?:[.,]0+)?$/.test(value))
        )
          throw new Error(
            "Correct prices/quantities using plain decimal text and the selected decimal separator.",
          );
      }
    }
  }
  return cfg;
}
function restore(v: Revision) {
  hydrating = true;
  const c = v.configuration;
  tableIndex.value = c.table_index;
  headerRow.value = c.header_row;
  repeat.value = c.repeat_headers;
  confirmed.value = c.structure_confirmed;
  verifiedOcr.value = c.ocr_verified_rows ?? [];
  corrections.value = JSON.parse(JSON.stringify(v.corrections));
  Object.assign(settings.value, {
    sku: c.columns.supplier_sku,
    price: c.columns.cost_price ?? "",
    description: c.columns.description ?? "",
    currencyColumn: c.columns.currency ?? "",
    packColumn: c.columns.pack_quantity ?? "",
    unitColumn: c.columns.unit ?? "",
    decimal: c.decimal_separator,
    thousands: c.thousands_separator ?? "",
    currency: c.currency ?? "",
    unit: c.unit ?? "",
    pack: c.pack_quantity ?? "",
    priceBasis: c.price_basis ?? defaultSettings().priceBasis,
    taxBasis: c.tax_basis ?? defaultSettings().taxBasis,
    symbol: c.currency_symbol ?? "",
    pdfRevisionId: v.confirmed ? v.id : undefined,
  });
  hydrating = false;
}
async function refresh(initial = false) {
  if (loading || disposed) return;
  clearTimeout(timer);
  const request = generation;
  loading = true;
  error.value = "";
  try {
    const meta: PdfInspectionState = await (
      await api(props.client, "/api/pdf", {
        tenantId: props.tenantId,
        fileId: props.fileId,
      })
    ).json();
    if (!active(request)) return;
    if (
      meta.fileId !== props.fileId ||
      !meta.inspection ||
      !meta.byteVerification
    )
      throw new Error(
        "PDF inspection response is incompatible. Refresh or contact your administrator.",
      );
    inspection.value = meta;
    const previousCount = pageCount.value;
    pageCount.value = meta.inspection.pageCount ?? 0;
    if (!previousCount && pageCount.value)
      last.value = Math.min(pageCount.value, 50);
    const result = await props.client
      .from("extraction_runs")
      .select("*")
      .eq("tenant_id", props.tenantId)
      .eq("source_file_id", props.fileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw result.error;
    if (!active(request)) return;
    extraction.value = result.data;
    if (initial && extraction.value) {
      const c = extraction.value.configuration;
      first.value = c.first_page;
      last.value = c.last_page;
      strategy.value = c.strategy;
    }
    if (extraction.value?.status === "ready") {
      const saved = await props.client
        .from("correction_revisions")
        .select("*")
        .eq("tenant_id", props.tenantId)
        .eq("extraction_run_id", extraction.value.id)
        .order("revision", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (saved.error) throw saved.error;
      if (!active(request)) return;
      revision.value = saved.data;
      if (initial && revision.value) restore(revision.value);
    }
  } catch (e) {
    if (active(request)) error.value = friendlyError(e);
  } finally {
    if (active(request)) {
      loading = false;
      schedule();
    }
  }
}
async function retryInspection() {
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    await api(props.client, "/api/uploads", {
      action: "finalize",
      tenantId: props.tenantId,
      fileId: props.fileId,
    });
    if (active(request)) await refresh();
  } catch (e) {
    if (active(request)) error.value = friendlyError(e);
  } finally {
    if (active(request)) busy.value = false;
  }
}
async function extract() {
  const request = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (!canExtract.value)
      throw new Error(
        "Select inspected digital-table candidate pages. OCR is disabled.",
      );
    if (
      !Number.isInteger(first.value) ||
      !Number.isInteger(last.value) ||
      first.value < 1 ||
      last.value < first.value ||
      last.value > pageCount.value ||
      last.value - first.value >= 50
    )
      throw new Error("Choose a page range within the PDF, up to 50 pages.");
    const response = await props.client.rpc("enqueue_pdf_extraction", {
      p_tenant: props.tenantId,
      p_file: props.fileId,
      p_configuration: {
        first_page: first.value,
        last_page: last.value,
        strategy: strategy.value,
      },
    });
    if (!active(request)) return;
    if (response.error) throw response.error;
    extraction.value = response.data.extraction;
    revision.value = null;
    corrections.value = {};
    confirmed.value = false;
    verifiedOcr.value = [];
    settings.value.pdfRevisionId = undefined;
    await refresh(true);
  } catch (e) {
    if (active(request)) error.value = friendlyError(e);
  } finally {
    if (active(request)) busy.value = false;
  }
}
async function save(confirm: boolean) {
  const request = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const cfg = validate();
    if (confirm && !confirmed.value)
      throw new Error(
        "Confirm the selected rows, columns and page continuation before reconciliation.",
      );
    if (
      confirm &&
      productRows.value.some(
        (r) =>
          ocrIds.value.has(r.record_id) &&
          !verifiedOcr.value.includes(r.record_id),
      )
    )
      throw new Error(
        "Verify each OCR product row against its source before confirming.",
      );
    if (confirm && retailGuidance.value)
      throw new Error(
        "Retail guidance cannot be confirmed for wholesale cost comparison or export. Save a review draft instead.",
      );
    if (confirm && unresolvedPricing.value)
      throw new Error(
        "Supplier pricing basis is unresolved; cost comparison/export is blocked. Save a review draft instead.",
      );
    const response = await props.client.rpc("save_pdf_revision", {
      p_tenant: props.tenantId,
      p_extraction: extraction.value!.id,
      p_expected: revision.value?.revision ?? 0,
      p_configuration: cfg,
      p_corrections: corrections.value,
      p_confirmed: confirm,
    });
    if (!active(request)) return;
    if (response.error) throw response.error;
    revision.value = response.data;
    settings.value.pdfRevisionId = confirm ? response.data.id : undefined;
    notice.value = confirm
      ? "PDF mapping confirmed. Ready for comparison."
      : "Correction draft saved.";
  } catch (e) {
    if (active(request)) error.value = friendlyError(e);
  } finally {
    if (active(request)) busy.value = false;
  }
}
watch(
  () => [
    settings.value.sku,
    settings.value.price,
    settings.value.description,
    settings.value.currencyColumn,
    settings.value.packColumn,
    settings.value.unitColumn,
    settings.value.decimal,
    settings.value.thousands,
    settings.value.currency,
    settings.value.unit,
    settings.value.pack,
    settings.value.priceBasis,
    settings.value.taxBasis,
    settings.value.symbol,
    tableIndex.value,
    headerRow.value,
    repeat.value,
    confirmed.value,
  ],
  () => {
    if (!hydrating) {
      settings.value.pdfRevisionId = undefined;
      notice.value = "";
    }
  },
  { flush: "sync" },
);
function initialize() {
  unsubscribe?.();
  const listener = props.client.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      generation++;
      clearTimeout(timer);
      disposed = true;
      inspection.value = null;
      extraction.value = null;
      revision.value = null;
      settings.value.pdfRevisionId = undefined;
    }
  });
  unsubscribe = () => listener.data.subscription.unsubscribe();
  generation++;
  clearTimeout(timer);
  loading = false;
  busy.value = false;
  inspection.value = null;
  extraction.value = null;
  revision.value = null;
  pageCount.value = 0;
  first.value = last.value = 1;
  corrections.value = {};
  verifiedOcr.value = [];
  confirmed.value = false;
  notice.value = "";
  error.value = "";
  hydrating = true;
  Object.assign(settings.value, {
    ...defaultSettings(),
    sku: "",
    price: "",
    description: "",
    currencyColumn: "",
    packColumn: "",
    unitColumn: "",
  });
  hydrating = false;
  void refresh(true);
}
watch(() => [props.tenantId, props.fileId, props.client], initialize);
onMounted(() => {
  initialize();
});
onUnmounted(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  unsubscribe?.();
});
</script>
<template>
  <section class="pdf-settings" :aria-label="'PDF import · ' + side">
    <h3>PDF · {{ side }}</h3>
    <section
      class="inspection-status"
      aria-label="PDF inspection"
      aria-live="polite"
    >
      <h4>{{ inspectionLabel(inspection) }}</h4>
      <p v-if="inspection?.byteVerification === 'verified'">
        Upload bytes verified. Inspection checks document structure only; no
        products have been extracted by inspection.
      </p>
      <p v-if="inspectionPending(inspection)">
        Processing is pending. You can leave and return; this page updates while
        processing continues.
      </p>
      <p v-if="inspection?.inspection.status === 'inspected'">
        Digital tables may be usable. Choose pages and explicitly extract them,
        then review corrections and confirm mapping before comparison.
      </p>
      <p v-if="inspection?.inspection.status === 'ocr_required'">
        Scanned or unsupported pages require OCR. OCR is disabled. Upload
        CSV/XLSX or a digital PDF with usable tables. Only candidate pages below
        can use digital extraction.
      </p>
      <p v-if="inspection?.inspection.status === 'failed'" role="alert">
        {{
          inspection.inspection.failure?.message ??
          "Document inspection could not finish."
        }}
        Upload a corrected file in a new comparison; this terminal inspection
        cannot be retried here.
      </p>
      <p v-if="inspection?.byteVerification === 'verifying'">
        Verification has not finished. An interrupted attempt expires after two
        minutes; the uploader can then retry finalization for this upload.
      </p>
      <p v-if="inspection?.byteVerification === 'failed'" role="alert">
        Choose a corrected file in a new comparison.
      </p>
      <template
        v-if="
          inspection?.byteVerification === 'verified' &&
          inspection.inspection.status === 'not_queued'
        "
      >
        <p>
          Bytes are saved, but inspection has not been queued. Retry without
          re-uploading.
        </p>
        <button type="button" :disabled="busy" @click="retryInspection">
          Retry inspection enqueue
        </button>
      </template>
      <ul
        v-if="inspection?.inspection.diagnostics?.length"
        class="inspection-pages"
      >
        <li v-for="page in inspection.inspection.diagnostics" :key="page.page">
          Page {{ page.page }} ·
          {{
            page.state === "digital_candidate"
              ? "Digital-table candidate"
              : "OCR required · disabled"
          }}<span v-if="page.state === 'digital_candidate'">
            · {{ page.table_count }} candidate table(s)</span
          >
        </li>
      </ul>
    </section>
    <p class="hint">
      Digital extraction is explicit. Inspection success alone does not make a
      file ready for comparison. OCR is disabled for scanned/unsupported
      documents.
    </p>
    <div class="field-grid">
      <label
        >First page<input
          v-model.number="first"
          type="number"
          min="1"
          :max="pageCount"
          :disabled="!pageCount"
      /></label>
      <label
        >Last page<input
          v-model.number="last"
          type="number"
          min="1"
          :max="pageCount"
          :disabled="!pageCount"
      /></label>
      <label
        >Table structure<select v-model="strategy">
          <option value="lines">Ruled table (visible grid)</option>
          <option value="text">Text-aligned columns (requires review)</option>
        </select></label
      >
    </div>
    <p class="hint">
      {{ pageCount }} pages available · select up to 50 per extraction.
    </p>
    <p v-if="!digitalPdfEnabled" class="hint">
      Digital extraction is disabled. Inspection does not make this PDF ready
      for comparison.
    </p>
    <button
      type="button"
      :disabled="
        busy ||
        !canExtract ||
        ['queued', 'running'].includes(extraction?.status ?? '')
      "
      @click="extract"
    >
      Extract selected pages
    </button>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="busy" @click="refresh(true)">
      Retry status check
    </button>
    <p v-if="notice" class="success-note" role="status">{{ notice }}</p>
    <p
      v-if="extraction && ['queued', 'running'].includes(extraction.status)"
      role="status"
    >
      {{
        extraction.status === "queued"
          ? "PDF extraction queued"
          : extraction.configuration.provider === "auto"
            ? "OCR processing · checking each page"
            : "Extracting digital PDF"
      }}
      · {{ extraction.completed_pages }} /
      {{ extraction.total_pages ?? "—" }} pages. You can leave and return.
    </p>
    <p
      v-if="extraction?.failure_reason && extraction.status === 'queued'"
      class="alert"
      role="status"
    >
      {{ extraction.failure_reason.message }} Retry scheduled; completed OCR
      pages will be reused.
    </p>
    <p
      v-if="extraction?.status === 'ready' && hasOcr"
      class="ocr-review-note"
      role="status"
    >
      OCR completed · correction/source verification required. Review every OCR
      product row before confirmation.
    </p>
    <section
      v-if="extraction?.status === 'ocr_required'"
      class="alert"
      role="alert"
    >
      <h4>OCR required</h4>
      <p>
        Selected pages lack reliable embedded text/table structure. OCR is
        disabled. Upload CSV/XLSX or a digital PDF with usable tables.
      </p>
    </section>
    <p v-if="extraction?.status === 'failed'" class="alert" role="alert">
      {{
        extraction.failure_reason?.message ??
        "PDF extraction failed. Export a fresh digital PDF or select fewer pages."
      }}
    </p>
    <details v-for="p in extraction?.raw_pages ?? []" :key="p.page">
      <summary>Source text · page {{ p.page }}</summary>
      <p class="hint">
        {{
          p.provider === "paddleocr-vl"
            ? "OCR extraction"
            : "Digital extraction"
        }}
        ·
        {{
          p.provider === "paddleocr-vl"
            ? p.confidence == null
              ? "Confidence unavailable; verify against source"
              : "Provider score " +
                p.confidence +
                " (uncalibrated); verify against source"
            : "Embedded text"
        }}
      </p>
      <p v-if="p.message" class="alert">{{ p.message }}</p>
      <pre class="pdf-source-text">{{ p.text || "(No embedded text)" }}</pre>
    </details>
    <template v-if="extraction?.status === 'ready'">
      <p
        v-for="warning in extraction.payload?.warnings.filter(
          (w) => w.code !== 'ocr_verification_required',
        ) ?? []"
        :key="warning.code + warning.message"
        class="hint"
      >
        {{ warning.message }}
      </p>
      <div class="field-grid">
        <label
          >Table on each page<select v-model.number="tableIndex">
            <option v-for="t in tables" :key="t" :value="t">
              Table {{ t }}
            </option>
          </select></label
        >
        <label
          >PDF header row<input
            v-model.number="headerRow"
            type="number"
            min="1"
            max="200"
        /></label>
        <label class="checkbox"
          ><input v-model="repeat" type="checkbox" />Skip exact repeated
          headers</label
        >
      </div>
      <p v-if="retailGuidance" class="ocr-review-note">
        Retail guidance only: both VAT price columns remain separate. No
        wholesale cost mapping or export is available. Save corrections as a
        review draft.
      </p>
      <p v-if="unresolvedPricing" class="ocr-review-note">
        Supplier pricing basis unresolved: pack quantities, lengths and raw
        units are source attributes, not a verified price denominator. Cost
        comparison and export remain blocked. Save corrections as a review
        draft. Currency: GBP. VAT basis:
        {{
          extraction?.payload?.records[0]?.semantic_candidates?.tax_basis ??
          "unstated"
        }}.
      </p>
      <CsvSettings
        v-if="!reviewOnly"
        v-model="settings"
        :side="side"
        :headers="headers"
        xlsx
        pdf
      />
      <h4>Original values and corrections</h4>
      <p class="hint">
        Original source text stays visible. Enter a replacement separately, or
        clear a value explicitly. Blank/invalid original prices require review.
        Prices use the selected decimal separator. Rows are never joined across
        pages.
      </p>
      <p class="hint pdf-scroll-hint">
        Scroll across the table to see every mapped field. Page and row stay
        visible.
      </p>
      <div
        class="table-wrap"
        tabindex="0"
        aria-label="PDF original values and corrections"
      >
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th v-for="(column, field) in mappings" :key="field">
                {{ String(field).replaceAll("_", " ") }} · {{ column }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in productRows.slice(offset, offset + 25)"
              :key="r.record_id"
            >
              <td>
                Page {{ locator(r).page }} · row {{ locator(r).row }}
                <p v-if="r.semantic_candidates?.section" class="hint">
                  {{ r.semantic_candidates.section }}
                </p>
                <p
                  v-if="r.semantic_candidates?.original_source_page"
                  class="hint"
                >
                  Original PDF page
                  {{ r.semantic_candidates.original_source_page }}
                </p>
                <p
                  v-for="cell in sourceAttributes(r)"
                  :key="cell.column_name"
                  class="hint"
                >
                  {{ cell.column_name }}: {{ cell.value || "(blank)" }}
                </p>
                <label v-if="ocrIds.has(r.record_id)" class="checkbox"
                  ><input
                    type="checkbox"
                    :aria-label="
                      'Verify OCR row page ' +
                      locator(r).page +
                      ' row ' +
                      locator(r).row
                    "
                    :checked="verifiedOcr.includes(r.record_id)"
                    @change="
                      verifyOcr(
                        r.record_id,
                        ($event.target as HTMLInputElement).checked,
                      )
                    "
                  />Checked against source</label
                >
              </td>
              <td v-for="(_, field) in mappings" :key="field">
                <span class="pdf-original"
                  >Original: {{ original(r, String(field)) || "(blank)" }}</span
                >
                <input
                  :aria-label="
                    'Correct ' +
                    String(field) +
                    ' page ' +
                    locator(r).page +
                    ' row ' +
                    locator(r).row
                  "
                  :value="corrections[r.record_id]?.[field] ?? ''"
                  placeholder="Use original"
                  maxlength="10000"
                  @input="
                    correct(
                      r,
                      String(field),
                      ($event.target as HTMLInputElement).value,
                    )
                  "
                />
                <button
                  type="button"
                  class="small-button"
                  @click="correct(r, String(field), null)"
                >
                  Clear value</button
                ><span
                  v-if="corrections[r.record_id]?.[field] === null"
                  class="hint"
                  >Cleared in this revision</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>{{ productRows.length }} product rows · 25 per page</span>
        <div>
          <button
            type="button"
            :disabled="offset === 0"
            @click="offset = Math.max(0, offset - 25)"
          >
            Previous rows</button
          ><button
            type="button"
            :disabled="offset + 25 >= productRows.length"
            @click="offset += 25"
          >
            Next rows
          </button>
        </div>
      </div>
      <label class="checkbox"
        ><input v-model="confirmed" type="checkbox" />I checked the selected
        table, headers, row boundaries and continuation on every selected
        page.</label
      >
      <div class="form-actions">
        <button type="button" :disabled="busy" @click="save(false)">
          Save correction draft</button
        ><button
          type="button"
          :disabled="busy || !confirmed"
          @click="save(true)"
        >
          Confirm PDF mapping
        </button>
      </div>
      <p v-if="revision" class="hint">
        Revision {{ revision.revision }} ·
        {{ revision.confirmed ? "confirmed" : "draft" }} ·
        {{ new Date(revision.created_at).toLocaleString() }} · user
        {{ revision.created_by }}. Original evidence is immutable.
      </p>
    </template>
  </section>
</template>
<style scoped>
.pdf-settings {
  min-width: 0;
  padding: 1rem 0;
  border-top: 1px solid var(--border, #d9dee6);
}
.inspection-status {
  margin: 1rem 0;
  padding: 1rem;
  background: #f7f9f8;
  border: 1px solid var(--border, #d9dee6);
  border-radius: 4px;
  overflow-wrap: anywhere;
}
.inspection-pages {
  max-height: 12rem;
  overflow: auto;
  padding-left: 1.25rem;
}
.ocr-review-note {
  padding: 1rem;
  border: 1px solid #e7d9bc;
  border-radius: 4px;
  background: #fbf7ee;
  color: #936b27;
}
.pdf-source-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.85rem;
  max-height: 20rem;
  overflow: auto;
}
.pdf-original {
  display: block;
  max-width: 18rem;
  overflow-wrap: anywhere;
  margin-bottom: 0.5rem;
  font-size: 0.85rem;
}
.pdf-scroll-hint {
  display: none;
}
.table-wrap th:first-child,
.table-wrap td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  background: white;
  min-width: 5rem;
}
.table-wrap th:first-child {
  background: #f7f9f8;
  z-index: 2;
}
@media (max-width: 1024px) {
  .pdf-scroll-hint {
    display: block;
  }
}
.table-wrap input {
  min-width: 9rem;
}
.checkbox {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0.5rem;
  margin: 1rem 0;
}
.checkbox input {
  width: 1rem;
  min-width: 1rem;
  min-height: 1rem;
  height: 1rem;
  padding: 0;
  margin-top: 0.15rem;
  flex: none;
}
.small-button {
  font-size: 0.75rem;
  margin-top: 0.35rem;
}
</style>
