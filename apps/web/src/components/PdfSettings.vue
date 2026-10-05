<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, csvOptions, defaultSettings, friendlyError } from "../workflow";
import type { Client, CsvSettings as Settings } from "../workflow";
import CsvSettings from "./CsvSettings.vue";
const props = defineProps<{
  client: Client;
  tenantId: string;
  fileId: string;
  side: string;
}>();
const settings = defineModel<Settings>({ required: true });
type Cell = { column_name: string; value: string | null; evidence_id: string };
type RecordRow = { record_id: string; raw_cells: Cell[] };
type Locator = { page: number; table: string; row: number };
type Extraction = {
  id: string;
  status: string;
  configuration: { first_page: number; last_page: number; strategy: string };
  completed_pages: number;
  total_pages: number | null;
  failure_reason: { message: string } | null;
  raw_pages: { page: number; text: string }[] | null;
  payload: {
    records: RecordRow[];
    evidence: { evidence_id: string; locator: Locator }[];
    warnings: { code: string; message: string }[];
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
const first = ref(1),
  last = ref(1),
  pageCount = ref(0),
  strategy = ref("lines");
const tableIndex = ref(1),
  headerRow = ref(1),
  repeat = ref(true),
  confirmed = ref(false);
const corrections = ref<Record<string, Record<string, string | null>>>({});
const error = ref(""),
  busy = ref(false),
  notice = ref(""),
  offset = ref(0);
let disposed = false,
  hydrating = false,
  loading = false,
  timer: ReturnType<typeof setInterval>;
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
const tables = computed(() =>
  [
    ...new Set(
      extraction.value?.payload?.records.map((r) => Number(locator(r).table)) ??
        [],
    ),
  ].sort((a, b) => a - b),
);
const selected = computed(() =>
  (extraction.value?.payload?.records ?? []).filter(
    (r) => locator(r).table === String(tableIndex.value),
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
      locator(r).row > headerRow.value &&
      !(
        repeat.value &&
        r.raw_cells.every((c, i) => (c.value ?? "") === headers.value[i])
      ) &&
      r.raw_cells.some((c) => c.value?.trim()),
  ),
);
const mappings = computed(
  () =>
    ({
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
      ...(settings.value.unitColumn ? { unit: settings.value.unitColumn } : {}),
    }) as Record<string, string>,
);
function original(r: RecordRow, field: string) {
  return (
    r.raw_cells[headers.value.indexOf(mappings.value[field]!)]?.value ?? null
  );
}
function correct(r: RecordRow, field: string, value: string | null) {
  settings.value.pdfRevisionId = undefined;
  notice.value = "Unsaved corrections";
  const entry = (corrections.value[r.record_id] ??= {});
  if (value === "") delete entry[field];
  else entry[field] = value;
  if (!Object.keys(entry).length) delete corrections.value[r.record_id];
}
function configuration() {
  if (
    !settings.value.sku ||
    !settings.value.price ||
    settings.value.sku === settings.value.price
  )
    throw new Error("Map PDF SKU and cost to distinct detected headers.");
  const mappedFields = [
    settings.value.currencyColumn && "currency",
    settings.value.packColumn && "pack_quantity",
    settings.value.unitColumn && "unit",
  ].filter(Boolean) as string[];
  return {
    ...csvOptions(settings.value, mappedFields),
    columns: mappings.value,
    table_index: tableIndex.value,
    header_row: headerRow.value,
    repeat_headers: repeat.value,
    structure_confirmed: confirmed.value,
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
      if (["cost_price", "pack_quantity"].includes(field) && value !== null) {
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
  corrections.value = JSON.parse(JSON.stringify(v.corrections));
  Object.assign(settings.value, {
    sku: c.columns.supplier_sku,
    price: c.columns.cost_price,
    description: c.columns.description ?? "",
    currencyColumn: c.columns.currency ?? "",
    packColumn: c.columns.pack_quantity ?? "",
    unitColumn: c.columns.unit ?? "",
    decimal: c.decimal_separator,
    thousands: c.thousands_separator ?? "",
    currency: c.currency ?? "",
    unit: c.unit ?? "",
    pack: c.pack_quantity ?? "",
    priceBasis: c.price_basis,
    taxBasis: c.tax_basis,
    symbol: c.currency_symbol ?? "",
    pdfRevisionId: v.confirmed ? v.id : undefined,
  });
  hydrating = false;
}
async function refresh(initial = false) {
  if (loading || disposed) return;
  loading = true;
  try {
    const result = await props.client
      .from("extraction_runs")
      .select("*")
      .eq("tenant_id", props.tenantId)
      .eq("source_file_id", props.fileId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (result.error) throw result.error;
    if (disposed) return;
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
      if (disposed) return;
      revision.value = saved.data;
      if (initial && revision.value) restore(revision.value);
    }
  } catch (e) {
    if (!disposed) error.value = friendlyError(e);
  } finally {
    loading = false;
  }
}
async function extract() {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
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
    if (response.error) throw response.error;
    extraction.value = response.data.extraction;
    revision.value = null;
    corrections.value = {};
    confirmed.value = false;
    settings.value.pdfRevisionId = undefined;
    await refresh(true);
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
async function save(confirm: boolean) {
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const cfg = validate();
    if (confirm && !confirmed.value)
      throw new Error(
        "Confirm the selected rows, columns and page continuation before reconciliation.",
      );
    const response = await props.client.rpc("save_pdf_revision", {
      p_tenant: props.tenantId,
      p_extraction: extraction.value!.id,
      p_expected: revision.value?.revision ?? 0,
      p_configuration: cfg,
      p_corrections: corrections.value,
      p_confirmed: confirm,
    });
    if (response.error) throw response.error;
    revision.value = response.data;
    settings.value.pdfRevisionId = confirm ? response.data.id : undefined;
    notice.value = confirm
      ? "PDF mapping confirmed. Ready for comparison."
      : "Correction draft saved.";
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
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
onMounted(async () => {
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
  try {
    const meta = await (
      await api(props.client, "/api/pdf", {
        tenantId: props.tenantId,
        fileId: props.fileId,
      })
    ).json();
    pageCount.value = meta.pages;
    last.value = Math.min(meta.pages, 50);
  } catch (e) {
    error.value = friendlyError(e);
  }
  await refresh(true);
  timer = setInterval(() => {
    if (
      extraction.value &&
      ["queued", "running"].includes(extraction.value.status)
    )
      void refresh();
  }, 1500);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <section class="pdf-settings" :aria-label="'PDF import · ' + side">
    <h3>Digital PDF · {{ side }}</h3>
    <p class="hint">
      Choose pages and table structure. Text is read directly; image-only or
      unsupported pages require OCR. No fields are guessed.
    </p>
    <div class="field-grid">
      <label
        >First page<input
          v-model.number="first"
          type="number"
          min="1"
          :max="pageCount"
      /></label>
      <label
        >Last page<input
          v-model.number="last"
          type="number"
          min="1"
          :max="pageCount"
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
    <button
      type="button"
      :disabled="
        busy ||
        !pageCount ||
        ['queued', 'running'].includes(extraction?.status ?? '')
      "
      @click="extract"
    >
      Extract selected pages
    </button>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <p v-if="notice" class="success-note" role="status">{{ notice }}</p>
    <p
      v-if="extraction && ['queued', 'running'].includes(extraction.status)"
      role="status"
    >
      {{
        extraction.status === "queued"
          ? "PDF extraction queued"
          : "Extracting digital PDF"
      }}
      · {{ extraction.completed_pages }} /
      {{ extraction.total_pages ?? "—" }} pages. You can leave and return.
    </p>
    <section
      v-if="extraction?.status === 'ocr_required'"
      class="alert"
      role="alert"
    >
      <h4>OCR required</h4>
      <p>
        Selected pages lack reliable embedded text/table structure. Upload
        CSV/XLSX or a ruled digital PDF. Scanned-image OCR is not available yet.
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
      <pre class="pdf-source-text">{{ p.text || "(No embedded text)" }}</pre>
    </details>
    <template v-if="extraction?.status === 'ready'">
      <p
        v-for="warning in extraction.payload?.warnings ?? []"
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
      <CsvSettings
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
              <td>Page {{ locator(r).page }} · row {{ locator(r).row }}</td>
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
