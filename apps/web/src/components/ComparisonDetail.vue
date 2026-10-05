<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  api,
  importOptions,
  defaultSettings,
  friendlyError,
  outcomeLabels,
  uploadCsv,
} from "../workflow";
import type { Client, ResultRow } from "../workflow";
import CsvSettings from "./CsvSettings.vue";
import PdfSettings from "./PdfSettings.vue";
import XlsxSettings from "./XlsxSettings.vue";
const props = defineProps<{
  client: Client;
  tenantId: string;
  comparisonId: string;
  canEdit: boolean;
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
      .select("id,status,current_file_id,incoming_file_id")
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
            accept=".pdf,application/pdf,.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            :disabled="busy || !!files[side]"
            @change="upload(side, $event)"
          /><small role="status">{{
            files[side]
              ? "✓ Verified and ready"
              : uploadState[side] || "CSV, XLSX or PDF · up to 10 MiB"
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
            !files.current ||
            !files.incoming ||
            (/\.pdf$/i.test(files.current?.original_filename ?? '') &&
              !currentSettings.pdfRevisionId) ||
            (/\.pdf$/i.test(files.incoming?.original_filename ?? '') &&
              !incomingSettings.pdfRevisionId)
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
              ? "No product rows were found in these CSV files."
              : "No results match this filter. Try another SKU or outcome."
          }}
        </p>
        <div v-else class="table-wrap">
          <table class="results-table">
            <thead>
              <tr>
                <th>Outcome</th>
                <th>SKU / Description</th>
                <th>Old cost</th>
                <th>New cost</th>
                <th>Exact delta</th>
                <th>Change %</th>
                <th>Flags / Review reason</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id">
                <td>
                  <span class="badge" :class="row.primary_outcome">{{
                    outcomeLabels[row.primary_outcome]
                  }}</span
                  ><small v-if="row.decision" class="muted"
                    >Excluded ·
                    {{
                      row.decision === "no_match" ? "no match" : "rejected"
                    }}</small
                  >
                </td>
                <td class="product-cell">
                  <strong>{{
                    row.new_values?.supplier_sku ??
                    row.old_values?.supplier_sku ??
                    "Missing SKU"
                  }}</strong
                  ><span>{{
                    row.new_values?.description ??
                    row.old_values?.description ??
                    "No description"
                  }}</span>
                </td>
                <td class="number">
                  {{ row.old_values?.cost_price ?? "—"
                  }}<small>{{ row.old_values?.currency }}</small>
                </td>
                <td class="number">
                  {{ row.new_values?.cost_price ?? "—"
                  }}<small>{{ row.new_values?.currency }}</small>
                </td>
                <td class="number">{{ row.cost_delta_text ?? "—" }}</td>
                <td class="number percent-cell">
                  {{
                    row.cost_change_percent_text !== null
                      ? `${row.cost_change_percent_text}%`
                      : row.percentage_state === "zero_old_cost"
                        ? "Undefined (old cost 0)"
                        : "—"
                  }}
                </td>
                <td class="reason-cell">
                  <span>{{
                    row.change_flags
                      .map((flag) => flag.replaceAll("_", " "))
                      .join(", ") || "—"
                  }}</span
                  ><small v-for="reason in row.reasons" :key="reason.code">{{
                    reason.message
                  }}</small>
                </td>
                <td>
                  <button class="quiet" @click="inspect(row)">
                    {{
                      row.review_state === "pending" && !row.decision
                        ? "Review"
                        : "Inspect"
                    }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <span
            >Showing {{ rows.length ? offset + 1 : 0 }}–{{
              offset + rows.length
            }}
            · 100 per page</span
          >
          <div>
            <button :disabled="!offset || tableLoading" @click="page(-1)">
              Previous</button
            ><button :disabled="!hasNextPage || tableLoading" @click="page(1)">
              Next
            </button>
          </div>
        </div>
      </section>
      <p class="hint">
        “Absent” means absent from this supplied file, not discontinued. Review
        flagged items before importing updates into your stock system.
      </p>
    </template>
  </template>
  <p v-else-if="error" class="alert" role="alert">
    {{ error }} <a href="#/comparisons">Return to comparisons</a>
  </p>
  <dialog ref="dialog" class="review-dialog" aria-labelledby="review-heading">
    <template v-if="selected"
      ><div class="dialog-heading">
        <div>
          <p class="eyebrow">Persisted source evidence</p>
          <h2 id="review-heading">
            {{
              selected.new_values?.supplier_sku ??
              selected.old_values?.supplier_sku ??
              "Missing identifier"
            }}
          </h2>
        </div>
        <button aria-label="Close evidence" @click="dialog?.close()">
          Close
        </button>
      </div>
      <div class="record-grid">
        <section
          v-for="(record, side) in {
            Current: selected.old_values,
            New: selected.new_values,
          }"
          :key="side"
        >
          <h3>{{ side }} record</h3>
          <p v-if="!record" class="muted">No paired record</p>
          <dl v-else>
            <template
              v-for="field in [
                'supplier_sku',
                'description',
                'cost_price',
                'currency',
                'unit',
                'pack_quantity',
                'price_basis',
                'tax_basis',
              ]"
              :key="field"
              ><dt>{{ field.replaceAll("_", " ") }}</dt>
              <dd>{{ record[field] ?? "—" }}</dd></template
            >
          </dl>
        </section>
      </div>
      <div v-if="selected.reasons.length" class="review-banner">
        <p v-for="reason in selected.reasons" :key="reason.code">
          {{ reason.message }} <small>({{ reason.code }})</small>
        </p>
      </div>
      <p v-if="candidate" class="hint">
        Candidate basis:
        {{
          candidate.basis === "exact_sku_review"
            ? "Exact SKU with compatibility issues"
            : "Unpaired record requiring review"
        }}. No confidence score is assigned.
      </p>
      <details ref="evidenceDetails">
        <summary>
          Field provenance ({{ selected.provenance.length }} references)
        </summary>
        <div class="table-wrap evidence-table">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Page / worksheet / row</th>
                <th>Column</th>
                <th>Source value</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="evidence in selected.provenance"
                :key="evidence.evidence_id"
              >
                <td>
                  {{
                    files.current?.id === evidence.source_file_id
                      ? files.current.original_filename
                      : (files.incoming?.original_filename ?? "Source file")
                  }}
                </td>
                <td class="number">
                  {{
                    evidence.locator.page
                      ? "Page " + evidence.locator.page + " / "
                      : evidence.locator.sheet
                        ? evidence.locator.sheet + " / "
                        : ""
                  }}{{ evidence.locator.row ?? "—" }}
                </td>
                <td>
                  {{
                    evidence.locator.column ??
                    evidence.field_name.replaceAll("_", " ")
                  }}
                </td>
                <td class="source-value">
                  {{ evidence.raw_text || "(blank)" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
      <section v-if="selected.decision" class="success-note">
        <h3>Decision recorded</h3>
        <p>{{ selected.decision }} · {{ selected.note }}</p>
        <small>{{ selected.reviewed_at }}</small>
      </section>
      <form
        v-else-if="selected.review_state === 'pending' && canEdit"
        class="review-actions"
        @submit.prevent="resolve('reject')"
      >
        <h3>Resolve this review item</h3>
        <p class="muted">
          These records cannot be safely approved as updates. Excluding them
          records your decision and preserves the original evidence.
        </p>
        <label
          >Decision reason<textarea
            v-model="note"
            required
            maxlength="1000"
            rows="3"
            placeholder="Explain why this item should be excluded"
          />
        </label>
        <p v-if="reviewError" class="alert" role="alert">{{ reviewError }}</p>
        <div class="form-actions">
          <button :disabled="reviewing">Reject candidate · exclude</button
          ><button
            v-if="!selected.old_values || !selected.new_values"
            type="button"
            :disabled="reviewing"
            @click="resolve('no_match')"
          >
            Confirm no match · exclude
          </button>
        </div>
      </form>
      <p v-else-if="selected.review_state === 'pending'" class="muted">
        An editor must resolve this item.
      </p>
    </template>
  </dialog>
</template>
