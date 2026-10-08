<script setup lang="ts">
import { computed } from "vue";
import type { Allowance } from "../allowance";
const props = defineProps<{
  allowance: Allowance | null;
  loading: boolean;
  error: string;
}>();
defineEmits<{ refresh: [] }>();
const remaining = computed(() => props.allowance?.comparisons_remaining);
const periodEnd = computed(() =>
  props.allowance?.period_end
    ? new Date(props.allowance.period_end).toLocaleString(undefined, {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    : "",
);
const bytes = (value: number) =>
  `${(value / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
</script>
<template>
  <section
    class="panel allowance-panel"
    aria-label="Workspace allowance"
    :aria-busy="loading"
  >
    <p v-if="loading" role="status">Checking workspace allowance…</p>
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p>
      <button @click="$emit('refresh')">Retry allowance check</button>
    </div>
    <template v-else-if="allowance">
      <div class="allowance-heading">
        <strong>{{
          allowance.plan === "pilot"
            ? "Pilot workspace"
            : allowance.plan === "paid"
              ? "Monthly comparison allowance"
              : "Trial comparison allowance"
        }}</strong>
        <button class="quiet" @click="$emit('refresh')">
          Refresh allowance
        </button>
      </div>
      <p v-if="allowance.plan === 'pilot'" class="muted">
        Your existing pilot access has no comparison or upload allowance cap.
      </p>
      <template v-else>
        <p class="allowance-count">
          <strong>{{ remaining }} of {{ allowance.comparison_limit }}</strong>
          comparisons remaining{{
            allowance.plan === "paid" ? " this billing period" : ""
          }}.
        </p>
        <p class="muted">
          {{ allowance.uploads_remaining }} of {{ allowance.upload_limit }} file
          reservations remaining · {{ bytes(allowance.bytes_remaining!) }} of
          {{ bytes(allowance.byte_limit!) }} upload allowance remaining.
        </p>
        <p v-if="periodEnd" class="muted">
          Current billing period ends {{ periodEnd }}. A renewed active
          subscription is required for the next allowance.
        </p>
        <p class="hint">
          A comparison is counted when processing is queued, including failed
          jobs. Worker retries do not spend another comparison. Upload
          reservations include pending and failed uploads and do not reset each
          month.
        </p>
        <p v-if="remaining === 0" class="allowance-warning" role="status">
          Comparison allowance reached. You can still open, review and export
          saved results.
        </p>
        <p
          v-else-if="
            allowance.uploads_remaining === 0 || allowance.bytes_remaining === 0
          "
          class="allowance-warning"
          role="status"
        >
          Upload allowance reached. You can still process a draft with two ready
          files and open saved results.
        </p>
        <p v-else-if="allowance.uploads_remaining === 1" class="hint">
          Only one file reservation remains. You can finish a draft with one
          ready file; a new comparison needs two reservations.
        </p>
        <p v-if="allowance.plan === 'trial'" class="hint">
          <a href="#/billing">View workspace billing</a> for subscription
          availability.
        </p>
      </template>
    </template>
  </section>
</template>
