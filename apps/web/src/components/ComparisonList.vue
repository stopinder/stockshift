<script setup lang="ts">
import { onMounted, ref } from "vue";
import { friendlyError } from "../workflow";
import type { Client } from "../workflow";
const props = defineProps<{
  client: Client;
  tenantId: string;
  canEdit: boolean;
}>();
const loading = ref(true),
  error = ref("");
const rows = ref<
  {
    id: string;
    title: string;
    supplier: string;
    date: string;
    status: string;
    total: number | null;
  }[]
>([]);
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [comparisons, runs] = await Promise.all([
      props.client
        .from("comparisons")
        .select("id,title,created_at,suppliers(name)")
        .eq("tenant_id", props.tenantId)
        .order("created_at", { ascending: false })
        .limit(100),
      props.client
        .from("comparison_runs")
        .select("comparison_id,status,result_count,created_at")
        .eq("tenant_id", props.tenantId)
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);
    if (comparisons.error || runs.error) throw comparisons.error ?? runs.error;
    rows.value = (comparisons.data ?? []).map((c) => {
      const run = runs.data?.find((r) => r.comparison_id === c.id);
      return {
        id: c.id,
        title: c.title,
        supplier:
          (c.suppliers as unknown as { name: string } | null)?.name ??
          "No supplier",
        date: new Date(c.created_at).toLocaleDateString(),
        status: run?.status ?? "draft",
        total: run?.result_count ?? null,
      };
    });
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="eyebrow">Catalogue workspace</p>
      <h1>Comparisons</h1>
      <p class="muted">
        Upload, review and export changes between supplier catalogues.
      </p>
    </div>
    <a v-if="canEdit" class="button primary" href="#/comparisons/new"
      >+ New comparison</a
    >
  </div>
  <div v-if="error" role="alert" class="alert">
    {{ error }} <button @click="load">Retry</button>
  </div>
  <p v-else-if="loading" class="panel state" role="status">
    Loading comparisons…
  </p>
  <section v-else-if="!rows.length" class="panel state">
    <h2>Your first comparison starts here</h2>
    <p>
      Bring your current catalogue and the supplier’s latest CSV. StockShift
      will show what changed.
    </p>
    <a v-if="canEdit" class="button primary" href="#/comparisons/new"
      >Create comparison</a
    >
    <p v-else class="muted">Ask an editor to create a comparison.</p>
  </section>
  <section v-else class="panel table-wrap" aria-label="Recent comparisons">
    <table>
      <thead>
        <tr>
          <th>Comparison</th>
          <th>Supplier</th>
          <th>Created</th>
          <th>Outcomes</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.id">
          <td>
            <a class="table-link" :href="`#/comparisons/${r.id}`">{{
              r.title
            }}</a>
          </td>
          <td>{{ r.supplier }}</td>
          <td>{{ r.date }}</td>
          <td class="number">{{ r.total ?? "—" }}</td>
          <td>
            <span class="badge" :class="r.status">{{
              r.status === "succeeded" ? "Complete" : r.status
            }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
  <p v-if="rows.length === 100" class="muted">
    Showing the latest 100 comparisons.
  </p>
</template>
