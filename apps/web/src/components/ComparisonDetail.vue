<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  api,
  csvOnly,
  importOptions,
  defaultSettings,
  friendlyError,
  outcomeLabels,
  uploadCsv,
  savedImportSettings,
  isNumericUnit,
} from "../workflow";
import type { Client, ResultRow } from "../workflow";
import { canCompare, canUpload, type Allowance } from "../allowance";
import CsvSettings from "./CsvSettings.vue";
import PdfSettings from "./PdfSettings.vue";
import XlsxSettings from "./XlsxSettings.vue";
const props = defineProps<{
  client: Client;
  tenantId: string;
  comparisonId: string;
  canEdit: boolean;
  allowance: Allowance | null;
  allowanceLoading: boolean;
  checkAllowance: () => Promise<Allowance | null>;
}>();
const loading = ref(true),
  error = ref(""),
  busy = ref(false),
  tableLoading = ref(false);
const comparison = ref<{
  title: string;
  supplier_id: string | null;
  created_at: string;
  suppliers: { name: string } | null;
} | null>(null);
const run = ref<{
  id: string;
  status: string;
  current_file_id: string;
  incoming_file_id: string;
  configuration: Record<string, unknown>;
} | null>(null);
const job = ref<{
  status: string;
  failure_reason: { code: string; stage: string; message: string } | null;
  attempt_count: number;
} | null>(null);
const files = ref<Record<string, { id: string; original_filename: string }>>(
  {},
);
const currentSettings = ref(defaultSettings()),
  incomingSettings = ref(defaultSettings());
const uploadState = ref<Record<string, string>>({ current: "", incoming: "" });
const summary = ref<{
  total: number | null;
  outcomes: Record<string, number>;
  unresolved: number;
  excluded: number;
} | null>(null);
const hasNextPage = ref(false);
const rows = ref<ResultRow[]>([]),
  outcome = ref(""),
  search = ref(""),
  offset = ref(0);
const selected = ref<ResultRow | null>(null),
  note = ref(""),
  dialog = ref<HTMLDialogElement | null>(null);
const reviewError = ref(""),
  reviewing = ref(false),
  downloaded = ref("");
const candidate = ref<{ basis: string; status: string } | null>(null);
const evidenceDetails = ref<HTMLDetailsElement | null>(null);
const displayState = computed(
  () => job.value?.status ?? run.value?.status ?? "draft",
);
const savedSettings = computed(() =>
  run.value ? savedImportSettings(run.value.configuration) : [],
);
const numericSavedUnit = computed(() =>
  savedSettings.value.some(
    (row) =>
      row.label === "Unit of measure" &&
      (isNumericUnit(row.current) || isNumericUnit(row.incoming)),
  ),
);
const exportReady = computed(
  () => run.value?.status === "succeeded" && summary.value?.unresolved === 0,
);
const exportHint = computed(() =>
  run.value?.status !== "succeeded"
    ? "Export becomes available after processing."
    : summary.value?.unresolved
      ? `Resolve ${summary.value.unresolved} review item(s) before export.`
      : "Exports changed products only. Excluded review rows stay out.",
);
let disposed = false,
  refreshing = false,
  tableRequest = 0;
async function loadRows() {
  if (!run.value || run.value.status !== "succeeded") return;
  const request = ++tableRequest;
  tableLoading.value = true;
  const result = await props.client.rpc("csv_results_page", {
    p_tenant: props.tenantId,
    p_run: run.value.id,
    p_outcome: outcome.value,
    p_search: search.value,
    p_offset: offset.value,
  });
  if (disposed || request !== tableRequest) return;
  tableLoading.value = false;
  if (result.error) {
    error.value = friendlyError(result.error);
    return;
  }
  hasNextPage.value = (result.data?.length ?? 0) > 100;
  rows.value = (result.data ?? []).slice(0, 100);
}
async function load(initial = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const detail = await props.client
      .from("comparisons")
      .select("title,supplier_id,created_at,suppliers(name)")
      .eq("tenant_id", props.tenantId)
      .eq("id", props.comparisonId)
      .maybeSingle();
    if (detail.error) throw detail.error;
    if (!detail.data)
      throw new Error(
        "Comparison unavailable. Check your workspace or return to Comparisons.",
      );
    comparison.value = detail.data as unknown as NonNullable<
      typeof comparison.value
    >;
    const latest = await props.client
      .from("comparison_runs")
      .select("id,status,current_file_id,incoming_file_id,configuration")
      .eq("tenant_id", props.tenantId)
      .eq("comparison_id", props.comparisonId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest.error) throw latest.error;
    const previousState = run.value?.status;
    run.value = latest.data;
    if (run.value) {
      const sources = await props.client
        .from("source_files")
        .select("id,original_filename")
        .eq("tenant_id", props.tenantId)
        .in("id", [run.value.current_file_id, run.value.incoming_file_id]);
      if (sources.error) throw sources.error;
      const current = sources.data.find(
        (f) => f.id === run.value?.current_file_id,
      );
      const incoming = sources.data.find(
        (f) => f.id === run.value?.incoming_file_id,
      );
      if (!current || !incoming)
        throw new Error(
          "Source metadata unavailable. Refresh this comparison or check workspace access.",
        );
      files.value = { current, incoming };
    } else {
      const links = await props.client
        .from("comparison_files")
        .select("side,source_files(id,original_filename)")
        .eq("tenant_id", props.tenantId)
        .eq("comparison_id", props.comparisonId);
      if (links.error) throw links.error;
      files.value = Object.fromEntries(
        (links.data ?? []).map((l) => [l.side, l.source_files]),
      ) as typeof files.value;
    }
    if (initial && !run.value) {
      for (const [side, settings] of [
        ["current", currentSettings],
        ["incoming", incomingSettings],
      ] as const) {
        if (/\.xlsx$/i.test(files.value[side]?.original_filename ?? "")) {
          try {
            Object.assign(
              settings.value,
              JSON.parse(
                localStorage.getItem(`xlsx:${props.comparisonId}:${side}`) ??
                  "{}",
              ),
            );
          } catch {
            /* fall back to explicit mapping */
          }
        }
      }
    }
    if (run.value) {
      const state = await props.client
        .from("jobs")
        .select("status,failure_reason,attempt_count")
        .eq("tenant_id", props.tenantId)
        .eq("comparison_run_id", run.value.id)
        .single();
      if (state.error) throw state.error;
      job.value = state.data;
      if (run.value.status === "succeeded") {
        const counts = await props.client.rpc("csv_run_summary", {
          p_tenant: props.tenantId,
          p_run: run.value.id,
        });
        if (counts.error) throw counts.error;
        summary.value = counts.data;
        if (initial || previousState !== "succeeded") await loadRows();
      }
    }
    if (initial) error.value = "";
  } catch (e) {
    if (!disposed) error.value = friendlyError(e);
  } finally {
    refreshing = false;
    loading.value = false;
  }
}
async function upload(side: string, event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || !comparison.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (!canUpload(await props.checkAllowance(), file.size))
      throw new Error(
        "This file exceeds the remaining workspace allowance, or no comparison allowance remains. Check the allowance above.",
      );
    const id = await uploadCsv(
      props.client,
      props.tenantId,
      comparison.value.supplier_id,
      file,
      (state) => {
        uploadState.value[side] = state;
      },
    );
    const attached = await props.client.from("comparison_files").insert({
      tenant_id: props.tenantId,
      comparison_id: props.comparisonId,
      source_file_id: id,
      side,
    });
    if (attached.error) throw attached.error;
    if (/\.xlsx$/i.test(file.name)) {
      const settings = side === "current" ? currentSettings : incomingSettings;
      settings.value = {
        ...defaultSettings(),
        sku: "",
        price: "",
        description: "",
        worksheet: "",
        headerRow: 1,
        currencyColumn: "",
        packColumn: "",
        unitColumn: "",
      };
    }
    await load();
  } catch (e) {
    error.value = friendlyError(e);
    uploadState.value[side] = "Failed — select the file to retry";
  } finally {
    await props.checkAllowance();
    busy.value = false;
    input.value = "";
  }
}
watch(
  [currentSettings, incomingSettings],
  () => {
    for (const [side, settings] of [
      ["current", currentSettings],
      ["incoming", incomingSettings],
    ] as const) {
      if (/\.xlsx$/i.test(files.value[side]?.original_filename ?? "")) {
        try {
          localStorage.setItem(
            `xlsx:${props.comparisonId}:${side}`,
            JSON.stringify(settings.value),
          );
        } catch {
          /* storage optional */
        }
      }
    }
  },
  { deep: true },
);
async function enqueue() {
  busy.value = true;
  error.value = "";
  try {
    if (!canCompare(await props.checkAllowance()))
      throw new Error(
        "No comparison allowance is available. Saved results remain accessible; check the allowance above.",
      );
    const a = importOptions(
        currentSettings.value,
        files.value.current!.original_filename,
      ),
      b = importOptions(
        incomingSettings.value,
        files.value.incoming!.original_filename,
      );
    for (const [side, settings] of [
      ["current", currentSettings],
      ["incoming", incomingSettings],
    ] as const) {
      if (/\.xlsx$/i.test(files.value[side]!.original_filename)) {
        const preview = await (
          await api(props.client, "/api/workbook", {
            tenantId: props.tenantId,
            fileId: files.value[side]!.id,
            worksheet: settings.value.worksheet,
            headerRow: settings.value.headerRow,
          })
        ).json();
        const options = side === "current" ? a : b;
        if (
          !("columns" in options) ||
          !Object.values(options.columns).every((h) =>
            preview.headers.includes(h),
          )
        )
          throw new Error(
            "Map every selected field to an available worksheet header.",
          );
      }
    }
    const result = await props.client.rpc("enqueue_comparison_job", {
      p_tenant: props.tenantId,
      p_comparison: props.comparisonId,
      p_key: `browser:${props.comparisonId}`,
      p_current_options: a,
      p_incoming_options: b,
    });
    if (result.error) throw result.error;
    await load();
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    await props.checkAllowance();
    busy.value = false;
  }
}
async function inspect(row: ResultRow) {
  selected.value = row;
  candidate.value = null;
  note.value = "";
  reviewError.value = "";
  await nextTick();
  if (evidenceDetails.value) evidenceDetails.value.open = false;
  dialog.value?.showModal();
  if (row.review_state === "pending" && run.value) {
    const result = await props.client
      .from("match_candidates")
      .select("basis,status")
      .eq("tenant_id", props.tenantId)
      .eq("comparison_run_id", run.value.id)
      .eq("comparison_result_id", row.id)
      .maybeSingle();
    if (selected.value?.id === row.id) {
      if (result.error) reviewError.value = friendlyError(result.error);
      else candidate.value = result.data;
    }
  }
}
async function resolve(decision: string) {
  if (!selected.value || !run.value || !note.value.trim()) {
    reviewError.value = "Add a reason for this decision.";
    return;
  }
  reviewing.value = true;
  reviewError.value = "";
  try {
    const result = await props.client.rpc("resolve_csv_review", {
      p_tenant: props.tenantId,
      p_run: run.value.id,
      p_result: selected.value.id,
      p_decision: decision,
      p_note: note.value.trim(),
    });
    if (result.error) throw result.error;
    selected.value.decision = result.data.decision;
    selected.value.note = result.data.note;
    selected.value.reviewed_at = result.data.created_at;
    await load(true);
    dialog.value?.close();
  } catch (e) {
    reviewError.value = friendlyError(e);
  } finally {
    reviewing.value = false;
  }
}
async function download() {
  if (!run.value) return;
  busy.value = true;
  error.value = "";
  downloaded.value = "";
  try {
    const response = await api(
      props.client,
      `/api/export?tenant=${props.tenantId}&run=${run.value.id}`,
    );
    const url = URL.createObjectURL(await response.blob()),
      link = document.createElement("a");
    link.href = url;
    link.download = "changed_products.csv";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloaded.value = "changed_products.csv downloaded.";
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
function filter() {
  offset.value = 0;
  void loadRows();
}
function page(direction: number) {
  offset.value = Math.max(0, offset.value + direction * 100);
  void loadRows();
}
let timer: ReturnType<typeof setInterval>;
onMounted(async () => {
  await load(true);
  timer = setInterval(() => {
    if (run.value && ["queued", "running"].includes(run.value.status))
      void load();
  }, 3000);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
});
</script>
<template>
  <a class="back-link" href="#/comparisons">← Comparisons</a>
  <p v-if="loading" class="panel state" role="status">Loading comparison…</p>
  <template v-else-if="comparison">
    <div class="page-heading">
      <div>
        <p class="eyebrow">
          {{ comparison.suppliers?.name ?? "Supplier comparison" }}
        </p>
        <h1>{{ comparison.title }}</h1>
        <p class="muted">
          Created {{ new Date(comparison.created_at).toLocaleString() }}
          <span class="badge" :class="displayState">{{
            displayState === "succeeded" ? "Complete" : displayState
          }}</span>
        </p>
      </div>
      <button
        v-if="run"
        class="primary"
        :disabled="!exportReady || busy"
        @click="download"
      >
        {{ busy ? "Preparing…" : "↓ Export changed products" }}
      </button>
    </div>
    <p v-if="run" class="hint export-hint">{{ exportHint }}</p>
    <p v-if="downloaded" role="status" class="success-note">{{ downloaded }}</p>
    <p v-if="error" role="alert" class="alert">
      {{ error }} <button @click="load(true)">Refresh</button>
    </p>
    <section class="source-strip" aria-label="Source files">
      <div>
        <span class="eyebrow">Current catalogue</span
        ><strong>{{
          files.current?.original_filename ?? "Not uploaded"
        }}</strong>
      </div>
      <div>
        <span class="eyebrow">New supplier catalogue</span
        ><strong>{{
          files.incoming?.original_filename ?? "Not uploaded"
        }}</strong>
      </div>
    </section>
    <details v-if="run" class="panel">
      <summary>Saved import settings</summary>
      <p class="hint">
        These are the settings used for this comparison and its export.
      </p>
      <p v-if="numericSavedUnit" class="alert" role="alert">
        This comparison used a number as its unit of measure. Unit should
        describe how the product is sold, such as each, box or kg; Pack quantity
        holds the number. The saved results have not been changed.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Setting</th>
              <th>Current catalogue</th>
              <th>New supplier catalogue</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in savedSettings" :key="row.label">
              <th scope="row">{{ row.label }}</th>
              <td>{{ row.current }}</td>
              <td>{{ row.incoming }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <form
      v-if="!run && canEdit"
      class="panel upload-form"
      @submit.prevent="enqueue"
    >
      <h2>Add your catalogue files</h2>
      <p class="muted">
        Files stay private. Upload and verification finish before background
        processing begins.
      </p>
      <div class="upload-grid">
        <label
          v-for="side in ['current', 'incoming']"
          :key="side"
          class="upload-box"
          ><span>{{
            side === "current" ? "Current catalogue" : "New supplier catalogue"
          }}</span
          ><input
            :aria-label="
              side === 'current'
                ? 'Current catalogue file'
                : 'New catalogue file'
            "
            type="file"
            :accept="
              csvOnly
                ? '.csv,text/csv'
                : '.pdf,application/pdf,.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            "
            :disabled="
              busy || allowanceLoading || !!files[side] || !canUpload(allowance)
            "
            @change="upload(side, $event)"
          /><small role="status">{{
            files[side]
              ? "✓ Verified and ready"
              : uploadState[side] ||
                (csvOnly
                  ? "CSV preview · up to 10 MiB"
                  : "CSV, XLSX or PDF · up to 10 MiB")
          }}</small></label
        >
      </div>
      <PdfSettings
        v-if="files.current?.original_filename.toLowerCase().endsWith('.pdf')"
        :key="files.current.id"
        v-model="currentSettings"
        :client="client"
        :tenant-id="tenantId"
        :file-id="files.current.id"
        side="current catalogue"
      />
      <XlsxSettings
        v-else-if="
          files.current?.original_filename.toLowerCase().endsWith('.xlsx')
        "
        v-model="currentSettings"
        :client="client"
        :tenant-id="tenantId"
        :file-id="files.current.id"
        side="current catalogue"
      />
      <CsvSettings v-else v-model="currentSettings" side="current catalogue" />
      <PdfSettings
        v-if="files.incoming?.original_filename.toLowerCase().endsWith('.pdf')"
        :key="files.incoming.id"
        v-model="incomingSettings"
        :client="client"
        :tenant-id="tenantId"
        :file-id="files.incoming.id"
        side="new catalogue"
      />
      <XlsxSettings
        v-else-if="
          files.incoming?.original_filename.toLowerCase().endsWith('.xlsx')
        "
        v-model="incomingSettings"
        :client="client"
        :tenant-id="tenantId"
        :file-id="files.incoming.id"
        side="new catalogue"
      />
      <CsvSettings v-else v-model="incomingSettings" side="new catalogue" />
      <div class="form-actions">
        <p class="hint">
          Your settings are saved with this comparison. You can leave while it
          processes.
        </p>
        <button
          class="primary"
          :disabled="
            busy ||
            allowanceLoading ||
            !canCompare(allowance) ||
            !files.current ||
            !files.incoming
          "
        >
          {{ busy ? "Working…" : "Start comparison" }}
        </button>
      </div>
    </form>
    <p v-else-if="!run" class="panel state">
      An editor needs to upload files and start this comparison.
    </p>
    <section
      v-if="run && ['queued', 'running'].includes(run.status)"
      class="panel processing"
      role="status"
    >
      <span class="activity" aria-hidden="true"></span>
      <div>
        <h2>
          {{
            displayState === "retry_wait"
              ? "Waiting to retry"
              : run.status === "running"
                ? "Comparing your catalogues"
                : "Comparison queued"
          }}
        </h2>
        <p>
          {{
            run.status === "running"
              ? "Your catalogue files are being compared. Results will appear here once processing finishes."
              : "Waiting for processing. This page updates automatically."
          }}
        </p>
        <p class="hint">
          You can leave and return to this comparison. Attempt
          {{ job?.attempt_count ?? 0 }}.
        </p>
      </div>
    </section>
    <section v-if="run?.status === 'failed'" class="panel failure" role="alert">
      <h2>Comparison could not finish</h2>
      <p>
        {{
          job?.failure_reason?.code === "invalid_xlsx_job"
            ? job.failure_reason.message
            : job?.failure_reason?.code === "invalid_csv_job"
              ? "Check the CSV headers, delimiter and number settings. Create a new comparison with corrected inputs."
              : "Processing failed. Ask your workspace administrator to check the processing service, then create a new comparison."
        }}
      </p>
      <p class="hint">
        Stage: {{ job?.failure_reason?.stage ?? "processing" }} ·
        {{ job?.failure_reason?.code ?? "job_failed" }}
      </p>
      <a v-if="canEdit" class="button" href="#/comparisons/new"
        >Create corrected comparison</a
      >
    </section>
    <template v-if="run?.status === 'succeeded' && summary">
      <section class="summary-grid" aria-label="Persisted outcome counts">
        <div>
          <span>Outcomes</span><strong>{{ summary.total }}</strong>
        </div>
        <div v-for="(label, key) in outcomeLabels" :key="key">
          <span>{{ label }}</span
          ><strong>{{ summary.outcomes[key] ?? 0 }}</strong>
        </div>
      </section>
      <p v-if="summary.unresolved" class="review-banner">
        {{ summary.unresolved }} item(s) need a decision. Inspect the evidence
        and exclude unsupported updates before export.
      </p>
      <p v-else-if="summary.excluded" class="success-note">
        {{ summary.excluded }} review item(s) explicitly excluded. Original
        outcomes and evidence are preserved.
      </p>
      <section class="panel results-panel">
        <form class="table-toolbar" @submit.prevent="filter">
          <label class="search-field"
            >Search SKU or description<input
              v-model="search"
              type="search"
              maxlength="200"
              placeholder="Search products…" /></label
          ><label
            >Outcome<select
              v-model="outcome"
              aria-label="Outcome"
              @change="filter"
            >
              <option value="">All outcomes</option>
              <option
                v-for="(label, key) in outcomeLabels"
                :key="key"
                :value="key"
              >
                {{ label }}
              </option>
            </select></label
          ><button :disabled="tableLoading">Search</button>
        </form>
        <p v-if="tableLoading" role="status" class="state">
          Loading persisted results…
        </p>
        <p v-else-if="!rows.length" class="state">
          {{
            summary.total === 0
              ? "No pro…7631 tokens truncated….75rem 1.2rem;
    padding: 1rem 16px;
  }
  .header-account {
    width: 100%;
    margin: 0;
    justify-content: space-between;
  }
  .header-account select {
    max-width: 250px;
  }
  .app-main {
    width: calc(100% - 32px);
    padding-top: 1.5rem;
  }
  .page-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .page-heading > button,
  .page-heading > .button {
    width: 100%;
  }
  .form-panel,
  .auth-panel,
  .upload-form {
    padding: 1.25rem;
  }
  .source-strip,
  .upload-grid,
  .field-grid,
  .record-grid {
    grid-template-columns: 1fr;
  }
  .table-toolbar {
    flex-wrap: wrap;
    gap: 0.7rem;
  }
  .search-field {
    flex-basis: 100%;
    max-width: none;
  }
  .table-toolbar > label:not(.search-field) {
    flex: 1;
  }
  .summary-grid > div {
    padding: 0.75rem;
  }
  .summary-grid strong {
    font-size: 1.4rem;
  }
  .export-hint {
    text-align: left;
    margin-top: 0;
  }
  .pagination {
    flex-wrap: wrap;
  }
  .app-footer {
    flex-direction: column;
    padding: 1rem 16px;
  }
  .form-actions > button {
    white-space: normal;
  }
  .auth-panel {
    margin: 1.5rem auto;
  }
}
.workbook-settings {
  min-width: 0;
  margin-top: 1.5rem;
}
.workbook-preview {
  max-height: 240px;
  margin-top: 1rem;
}
.workbook-settings select {
  max-width: 100%;
}
.marketing-main {
  max-width: 1360px;
  padding-top: 0;
}
.landing-nav {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  padding: 20px 0;
}
.landing-hero {
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  align-items: center;
  gap: 50px;
  padding: 65px 0 75px;
}
.hero-copy h1 {
  font-size: clamp(42px, 4.7vw, 68px);
  line-height: 1.06;
  letter-spacing: -0.055em;
  margin: 22px 0;
  font-weight: 650;
}
.hero-copy em {
  font-style: normal;
  color: #34755e;
}
.hero-description {
  max-width: 470px;
  font-size: 17px;
  line-height: 1.7;
  color: #56655e;
}
.hero-actions {
  display: flex;
  gap: 18px;
  align-items: center;
  margin: 28px 0 20px;
}
.hero-actions .button,
.landing-close .button {
  min-height: 48px;
  padding: 12px 22px;
}
.hero-note {
  font-size: 12px;
  color: #68736e;
}
.product-preview {
  background: white;
  border: 1px solid #dce2de;
  border-radius: 10px;
  box-shadow: 0 20px 60px #16221d0c;
  overflow: hidden;
  scroll-margin-top: 30px;
}
.preview-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px;
  border-bottom: 1px solid #e6eae7;
}
.preview-heading p {
  font-size: 12px;
  color: #68736e;
}
.preview-icon {
  background: #eaf1ed;
  color: #174c3c;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 23px;
}
.example-label {
  font-size: 10px;
  color: #68736e;
  border: 1px solid #dce2de;
  border-radius: 4px;
  padding: 4px 7px;
}
.preview-heading .example-label {
  margin-left: auto;
}
.preview-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  padding: 20px;
  gap: 16px;
}
.preview-summary strong {
  display: block;
  font-size: 26px;
  font-weight: 600;
}
.preview-summary span {
  font-size: 11px;
  color: #68736e;
}
.preview-table-wrap {
  overflow: auto;
}
.preview-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.preview-table th {
  text-align: left;
  background: #f7f8f7;
  font-weight: 500;
  color: #68736e;
  padding: 10px 14px;
}
.preview-table td {
  padding: 17px 14px;
  border-bottom: 1px solid #edf0ee;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.preview-table td strong {
  display: block;
  font-weight: 550;
}
.preview-table td span {
  display: block;
  font-size: 10px;
  color: #68736e;
  margin-top: 4px;
}
.preview-table .up {
  color: #a04a42;
}
.preview-table .down {
  color: #2f6b4f;
}
.preview-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  font-size: 10px;
  color: #68736e;
}
.export-example {
  color: #174c3c;
  font-weight: 600;
}
.promise-strip {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 23px 0;
  border-top: 1px solid #dce2de;
  border-bottom: 1px solid #dce2de;
  font-size: 13px;
  color: #56655e;
}
.landing-section {
  padding: 85px 0;
  scroll-margin-top: 20px;
}
.landing-section h2,
.trust-section h2,
.landing-close h2 {
  font-size: clamp(28px, 3vw, 42px);
  letter-spacing: -0.04em;
  line-height: 1.15;
  margin: 18px 0 30px;
}
.steps-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 50px;
  margin-top: 45px;
}
.step-number {
  display: block;
  color: #6d8f7e;
  font-size: 15px;
  margin-bottom: 20px;
}
.steps-grid h3 {
  font-size: 18px;
  margin-bottom: 12px;
}
.steps-grid p,
.trust-section p,
.launch-section p {
  font-size: 15px;
  line-height: 1.7;
  color: #68736e;
}
.trust-section {
  background: #eaf1ed;
  padding: 55px;
  border-radius: 8px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 80px;
}
.trust-section ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.trust-section li {
  padding: 15px 0;
  border-bottom: 1px solid #d1dfd7;
}
.trust-section li:last-child {
  border: 0;
}
.trust-section li strong,
.trust-section li span {
  display: block;
}
.trust-section li span {
  color: #68736e;
  margin-top: 5px;
}
.launch-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 90px;
  align-items: center;
}
.launch-card {
  background: white;
  border: 1px solid #dce2de;
  border-radius: 8px;
  padding: 32px;
}
.launch-card h3 {
  font-size: 22px;
  margin: 18px 0;
}
.launch-card ul {
  padding-left: 19px;
  line-height: 2;
}
.launch-card p {
  font-size: 12px;
  margin: 20px 0;
}
.launch-card .button {
  width: 100%;
}
.faq-section {
  border-top: 1px solid #dce2de;
}
.faq-section details {
  padding: 20px 0;
  border-bottom: 1px solid #dce2de;
}
.faq-section summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 16px;
}
.faq-section details p {
  max-width: 800px;
  color: #68736e;
  margin-top: 15px;
}
.landing-close {
  text-align: center;
  padding: 65px 20px 95px;
}
.workspace-create {
  max-width: 420px;
  margin: 25px auto;
  text-align: left;
  display: grid;
  gap: 15px;
}
@media (max-width: 1000px) {
  .landing-hero {
    grid-template-columns: 1fr;
    gap: 40px;
    padding-top: 30px;
  }
  .hero-copy h1 {
    font-size: 56px;
  }
  .hero-description {
    max-width: 650px;
  }
  .trust-section,
  .launch-section {
    gap: 35px;
  }
  .steps-grid {
    gap: 25px;
  }
}
@media (max-width: 650px) {
  .landing-nav {
    gap: 4px;
    flex-wrap: wrap;
  }
  .landing-nav .quiet {
    font-size: 12px;
    padding: 8px;
  }
  .landing-nav .button {
    font-size: 12px;
  }
  .hero-copy h1 {
    font-size: 42px;
  }
  .hero-description {
    font-size: 15px;
  }
  .promise-strip {
    display: grid;
    grid-template-columns: 1fr 1fr;
    font-size: 12px;
  }
  .steps-grid,
  .trust-section,
  .launch-section {
    grid-template-columns: 1fr;
  }
  .trust-section {
    padding: 28px 22px;
  }
  .landing-section {
    padding: 55px 0;
  }
  .preview-heading {
    flex-wrap: wrap;
    padding: 15px;
  }
  .preview-heading .example-label {
    margin-left: 0;
  }
  .preview-footer {
    flex-direction: column;
  }
  .preview-table td,
  .preview-table th {
    padding: 12px 10px;
  }
  .launch-card {
    padding: 24px;
  }
}
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto !important;
  }
}

.allowance-panel {
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}
.allowance-panel p {
  margin: 0.4rem 0;
  overflow-wrap: anywhere;
}
.allowance-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.allowance-count strong {
  color: #174c3c;
  font-variant-numeric: tabular-nums;
}
.allowance-warning {
  color: #936b27;
  font-weight: 600;
}
