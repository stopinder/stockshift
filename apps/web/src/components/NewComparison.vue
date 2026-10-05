<script setup lang="ts">
import { onMounted, ref } from "vue";
import { friendlyError } from "../workflow";
import type { Client } from "../workflow";
const props = defineProps<{ client: Client; tenantId: string }>();
const emit = defineEmits<{ created: [id: string] }>();
const suppliers = ref<{ id: string; name: string }[]>([]),
  supplier = ref(""),
  newSupplier = ref(""),
  title = ref("");
const error = ref(""),
  busy = ref(false);
onMounted(async () => {
  const { data, error: failure } = await props.client
    .from("suppliers")
    .select("id,name")
    .eq("tenant_id", props.tenantId)
    .order("name");
  if (failure) error.value = friendlyError(failure);
  else suppliers.value = data ?? [];
});
async function create() {
  busy.value = true;
  error.value = "";
  try {
    let supplierId = supplier.value;
    if (supplierId === "new") {
      const saved = await props.client
        .from("suppliers")
        .insert({ tenant_id: props.tenantId, name: newSupplier.value.trim() })
        .select("id")
        .single();
      if (saved.error) throw saved.error;
      supplierId = saved.data.id;
      suppliers.value.push({ id: supplierId, name: newSupplier.value.trim() });
      supplier.value = supplierId;
    }
    const saved = await props.client
      .from("comparisons")
      .insert({
        tenant_id: props.tenantId,
        supplier_id: supplierId,
        title: title.value.trim(),
      })
      .select("id")
      .single();
    if (saved.error) throw saved.error;
    emit("created", saved.data.id);
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <a class="back-link" href="#/comparisons">← Comparisons</a>
  <div class="page-heading">
    <div>
      <p class="eyebrow">Upload → Compare → Review → Export</p>
      <h1>New comparison</h1>
      <p class="muted">
        Start with a supplier, then add your two CSV catalogues.
      </p>
    </div>
  </div>
  <form class="panel form-panel" @submit.prevent="create">
    <label
      >Comparison name<input
        v-model="title"
        required
        maxlength="200"
        placeholder="October supplier price update" /></label
    ><label
      >Supplier<select v-model="supplier" aria-label="Supplier" required>
        <option disabled value="">Choose a supplier</option>
        <option v-for="s in suppliers" :key="s.id" :value="s.id">
          {{ s.name }}
        </option>
        <option value="new">+ Create supplier</option>
      </select></label
    ><label v-if="supplier === 'new'"
      >Supplier name<input
        v-model="newSupplier"
        required
        maxlength="200"
        placeholder="Supplier name"
    /></label>
    <p v-if="error" role="alert" class="alert">{{ error }}</p>
    <div class="form-actions">
      <a class="button" href="#/comparisons">Cancel</a
      ><button class="primary" :disabled="busy">
        {{ busy ? "Creating…" : "Continue to files" }}
      </button>
    </div>
  </form>
</template>
