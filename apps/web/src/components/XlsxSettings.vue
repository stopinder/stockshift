<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { api, friendlyError } from "../workflow";
import type { Client, CsvSettings as Settings } from "../workflow";
import CsvSettings from "./CsvSettings.vue";
const props = defineProps<{
  client: Client;
  tenantId: string;
  fileId: string;
  side: string;
}>();
const settings = defineModel<Settings>({ required: true });
const sheets = ref<{ name: string; state: string }[]>([]),
  headers = ref<string[]>([]),
  samples = ref<string[][]>([]);
const error = ref(""),
  loading = ref(false);
let request = 0;
async function discover() {
  const current = ++request;
  loading.value = true;
  error.value = "";
  headers.value = [];
  samples.value = [];
  try {
    const output = await (
      await api(props.client, "/api/workbook", {
        tenantId: props.tenantId,
        fileId: props.fileId,
        ...(settings.value.worksheet
          ? {
              worksheet: settings.value.worksheet,
              headerRow: settings.value.headerRow ?? 1,
            }
          : {}),
      })
    ).json();
    if (current !== request) return;
    sheets.value = output.worksheets;
    headers.value = output.headers ?? [];
    samples.value = output.samples ?? [];
  } catch (e) {
    if (current === request) error.value = friendlyError(e);
  } finally {
    if (current === request) loading.value = false;
  }
}
watch(() => settings.value.worksheet, discover);
onMounted(discover);
</script>
<template>
  <section class="workbook-settings">
    <h3>XLSX worksheet · {{ side }}</h3>
    <p class="hint">
      Choose the data worksheet and its header row. Preview comes from the same
      server-side parser used during processing. Formulas are not calculated.
    </p>
    <div class="field-grid">
      <label
        >Worksheet<select
          v-model="settings.worksheet"
          aria-label="Worksheet"
          required
        >
          <option value="">Choose worksheet</option>
          <option
            v-for="sheet in sheets"
            :key="sheet.name"
            :value="sheet.name"
            :disabled="sheet.state !== 'visible'"
          >
            {{ sheet.name }}{{ sheet.state !== "visible" ? " (hidden)" : "" }}
          </option>
        </select></label
      >
      <label
        >Header row<input
          v-model.number="settings.headerRow"
          type="number"
          min="1"
          max="200"
          required
      /></label>
    </div>
    <button type="button" :disabled="loading" @click="discover">
      {{ loading ? "Reading workbook…" : "Refresh header preview" }}
    </button>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <div
      v-if="headers.length"
      class="table-wrap workbook-preview"
      tabindex="0"
      aria-label="Worksheet sample rows"
    >
      <table>
        <thead>
          <tr>
            <th v-for="h in headers" :key="h">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, index) in samples" :key="index">
            <td v-for="(cell, i) in row" :key="i" class="source-value">
              {{ cell || "(blank)" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <CsvSettings v-model="settings" :side="side" :headers="headers" xlsx />
  </section>
</template>
