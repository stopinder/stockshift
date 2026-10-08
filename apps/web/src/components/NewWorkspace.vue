<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { Client } from "../workflow";
import {
  parseWorkspaceCreationStatus,
  workspaceCreationError,
  type WorkspaceCreationStatus,
} from "../workspaces";
const props = defineProps<{
  client: Client;
  testMode: boolean;
  hasWorkspace: boolean;
}>();
const emit = defineEmits<{
  created: [id: string, requiresSubscription: boolean];
}>();
const name = ref(""),
  testWorkspace = ref(false),
  busy = ref(false),
  loading = ref(true),
  error = ref("");
const status = ref<WorkspaceCreationStatus | null>(null);
let disposed = false,
  requestId = crypto.randomUUID(),
  draftKey = "";
function saveDraft() {
  if (draftKey)
    sessionStorage.setItem(
      draftKey,
      JSON.stringify({
        name: name.value,
        testWorkspace: testWorkspace.value,
        requestId,
      }),
    );
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const session = await props.client.auth.getSession();
    if (!session.data.session)
      throw new Error("Sign in again before creating a workspace.");
    draftKey = `stockshift.workspace-draft.${session.data.session.user.id}`;
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) ?? "null");
      if (
        draft &&
        typeof draft.name === "string" &&
        /^[0-9a-f-]{36}$/.test(draft.requestId)
      ) {
        name.value = draft.name;
        requestId = draft.requestId;
        testWorkspace.value = props.testMode && draft.testWorkspace === true;
      }
    } catch {
      sessionStorage.removeItem(draftKey);
    }
    const result = await props.client.rpc("workspace_creation_status");
    if (result.error) throw result.error;
    if (!disposed) status.value = parseWorkspaceCreationStatus(result.data);
  } catch (e) {
    if (!disposed)
      error.value =
        e instanceof Error
          ? e.message
          : "We could not check workspace availability. Try again.";
  } finally {
    if (!disposed) loading.value = false;
  }
}
async function create() {
  if (
    busy.value ||
    loading.value ||
    !status.value ||
    status.value.owned_count >= status.value.workspace_limit
  )
    return;
  busy.value = true;
  error.value = "";
  saveDraft();
  try {
    const result = await props.client.rpc("create_business_workspace", {
      p_name: name.value.trim(),
      p_request: requestId,
      p_test: props.testMode && testWorkspace.value,
    });
    if (result.error) throw result.error;
    const data = result.data as {
      tenant_id?: unknown;
      subscription_required?: unknown;
    };
    if (
      typeof data?.tenant_id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(data.tenant_id) ||
      typeof data.subscription_required !== "boolean"
    )
      throw new Error("Invalid creation response");
    if (disposed) return;
    sessionStorage.removeItem(draftKey);
    emit("created", data.tenant_id, data.subscription_required);
  } catch (e) {
    if (!disposed) error.value = workspaceCreationError(e);
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(() => void load());
onUnmounted(() => {
  disposed = true;
});
</script>
<template>
  <section
    class="panel auth-panel"
    aria-label="Create workspace"
    :aria-busy="busy || loading"
  >
    <p class="eyebrow">Separate business, separate subscription</p>
    <h1>Create workspace</h1>
    <p v-if="loading" role="status">Checking workspace availability…</p>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <template v-if="status">
      <p class="muted">
        {{ status.owned_count }} of {{ status.workspace_limit }} owned
        workspaces. Each business keeps its own catalogues, comparisons and
        subscription.
      </p>
      <p
        v-if="status.owned_count >= status.workspace_limit"
        class="alert"
        role="status"
      >
        Workspace limit reached. Contact support before adding another business.
      </p>
      <form v-else @submit.prevent="create">
        <label
          >Business or workspace name<input
            v-model="name"
            maxlength="200"
            required
            :disabled="busy"
            @input="saveDraft"
        /></label>
        <label v-if="testMode" class="test-workspace-choice"
          ><input
            v-model="testWorkspace"
            type="checkbox"
            :disabled="busy"
            @change="saveDraft"
          />
          Stripe test workspace</label
        >
        <p v-if="testWorkspace" class="hint">
          No real charges. This workspace is only for Stripe testing, gets no
          additional free comparisons and cannot receive live payments. It
          counts towards the workspace limit.
        </p>
        <p v-else-if="status.trial_available" class="hint">
          Your first business workspace includes three trial comparisons. This
          is the only free trial for your account.
        </p>
        <p v-else class="hint">
          This business needs its own £29/month subscription for 20 comparisons
          per active billing period. Creating it does not charge you. Uploads
          and processing stay locked until its subscription is active.
        </p>
        <button class="primary" :disabled="busy || !name.trim()">
          {{ busy ? "Creating…" : "Create workspace" }}
        </button>
      </form>
    </template>
    <button v-else-if="!loading" class="quiet" @click="load">
      Retry availability check
    </button>
    <p v-if="hasWorkspace">
      <a href="#/comparisons">Cancel and return to comparisons</a>
    </p>
  </section>
</template>
