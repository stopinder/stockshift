<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Session } from "@supabase/supabase-js";
import { browserClient, friendlyError } from "./workflow";
import ComparisonList from "./components/ComparisonList.vue";
import NewComparison from "./components/NewComparison.vue";
import ComparisonDetail from "./components/ComparisonDetail.vue";
let client: ReturnType<typeof browserClient> | null = null;
const configError = ref("");
try {
  client = browserClient();
} catch {
  configError.value =
    "This application is not connected to a workspace. Ask your administrator to configure the application services, then reload.";
}
const session = ref<Session | null>(null),
  ready = ref(false),
  busy = ref(false),
  error = ref("");
const email = ref(""),
  password = ref(""),
  route = ref(location.hash.slice(1) || "/comparisons");
const tenants = ref<{ id: string; name: string; role: string }[]>([]),
  tenantId = ref("");
const tenant = computed(() =>
  tenants.value.find((t) => t.id === tenantId.value),
);
const canEdit = computed(() =>
  ["owner", "editor"].includes(tenant.value?.role ?? ""),
);
const comparisonId = computed(
  () => /^\/comparisons\/([0-9a-f-]{36})$/.exec(route.value)?.[1],
);
function hashChanged() {
  route.value = location.hash.slice(1) || "/comparisons";
  error.value = "";
}
function navigate(path: string) {
  location.hash = path;
}
function focusMain() {
  document.getElementById("main")?.focus();
}
async function memberships() {
  if (!client || !session.value) return;
  const { data, error: failure } = await client
    .from("tenant_memberships")
    .select("tenant_id,role,tenants(id,name)")
    .eq("user_id", session.value.user.id);
  if (failure) {
    error.value = friendlyError(failure);
    tenants.value = [];
    return;
  }
  tenants.value = (data ?? []).map((row) => ({
    id: row.tenant_id,
    role: row.role,
    name: (row.tenants as unknown as { name: string }).name,
  }));
  const previous = localStorage.getItem("stockshift.tenant");
  tenantId.value =
    tenants.value.find((t) => t.id === previous)?.id ??
    tenants.value[0]?.id ??
    "";
}
function changeTenant() {
  localStorage.setItem("stockshift.tenant", tenantId.value);
  navigate("/comparisons");
}
async function signIn() {
  if (!client) return;
  busy.value = true;
  error.value = "";
  try {
    const login = await client.auth.signInWithPassword({
      email: email.value,
      password: password.value,
    });
    if (login.error)
      throw new Error(
        "Sign-in failed. Check your email and password and try again.",
      );
    session.value = login.data.session;
    password.value = "";
    await memberships();
    navigate("/comparisons");
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
async function signOut() {
  if (!client) return;
  const result = await client.auth.signOut({ scope: "local" });
  if (result.error) {
    error.value = "Sign-out failed. Try again.";
    return;
  }
  session.value = null;
  tenants.value = [];
  tenantId.value = "";
  navigate("/login");
}
let unsubscribe: (() => void) | undefined;
onMounted(async () => {
  window.addEventListener("hashchange", hashChanged);
  if (client) {
    const { data } = await client.auth.getSession();
    if (data.session) {
      const identity = await client.auth.getUser();
      if (
        !identity.error &&
        identity.data.user &&
        !identity.data.user.is_anonymous
      ) {
        session.value = data.session;
        await memberships();
      } else {
        await client.auth.signOut({ scope: "local" });
        error.value = "Your session expired. Sign in again.";
      }
    }
    const listener = client.auth.onAuthStateChange((event, next) => {
      session.value = next;
      if (event === "SIGNED_OUT") {
        tenants.value = [];
        tenantId.value = "";
        navigate("/login");
      }
    });
    unsubscribe = () => listener.data.subscription.unsubscribe();
  }
  ready.value = true;
});
onUnmounted(() => {
  unsubscribe?.();
  window.removeEventListener("hashchange", hashChanged);
});
</script>
<template>
  <a class="skip-link" href="#main" @click.prevent="focusMain"
    >Skip to content</a
  >
  <header class="app-header">
    <a class="brand" href="#/comparisons"
      ><span class="brand-mark" aria-hidden="true">S</span>StockShift</a
    >
    <template v-if="session">
      <nav aria-label="Main navigation">
        <a
          href="#/comparisons"
          :aria-current="route === '/comparisons' ? 'page' : undefined"
          >Comparisons</a
        >
      </nav>
      <div class="header-account">
        <label class="sr-only" for="workspace">Workspace</label
        ><select id="workspace" v-model="tenantId" @change="changeTenant">
          <option v-for="t in tenants" :key="t.id" :value="t.id">
            {{ t.name }}
          </option></select
        ><button class="quiet" @click="signOut">Sign out</button>
      </div>
    </template>
  </header>
  <main id="main" class="app-main" tabindex="-1">
    <p v-if="!ready" role="status" class="state">Loading your workspace…</p>
    <section v-else-if="configError" class="panel auth-panel">
      <h1>Workspace unavailable</h1>
      <p>{{ configError }}</p>
    </section>
    <section v-else-if="!session" class="panel auth-panel">
      <p class="eyebrow">Your catalogue workspace</p>
      <h1>Welcome back</h1>
      <p class="muted">Sign in to compare supplier files and review changes.</p>
      <form @submit.prevent="signIn">
        <label
          >Email<input
            v-model="email"
            type="email"
            autocomplete="username"
            required /></label
        ><label
          >Password<input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
        /></label>
        <p v-if="error" role="alert" class="alert">{{ error }}</p>
        <button class="primary" :disabled="busy">
          {{ busy ? "Signing in…" : "Sign in" }}
        </button>
      </form>
    </section>
    <template v-else>
      <p v-if="error" role="alert" class="alert">{{ error }}</p>
      <section v-if="!tenant" class="panel state">
        <h1>No workspace access</h1>
        <p>Ask a workspace owner to add your account, then sign in again.</p>
      </section>
      <template v-else-if="client"
        ><div class="workspace-line">
          {{ tenant.name }} <span class="badge">{{ tenant.role }}</span>
        </div>
        <NewComparison
          v-if="route === '/comparisons/new' && canEdit"
          :key="tenantId"
          :client="client"
          :tenant-id="tenantId"
          @created="(id) => navigate(`/comparisons/${id}`)"
        />
        <ComparisonDetail
          v-else-if="comparisonId"
          :key="`${tenantId}:${comparisonId}`"
          :client="client"
          :tenant-id="tenantId"
          :comparison-id="comparisonId"
          :can-edit="canEdit"
        />
        <ComparisonList
          v-else
          :key="tenantId"
          :client="client"
          :tenant-id="tenantId"
          :can-edit="canEdit"
        />
      </template>
    </template>
  </main>
  <footer class="app-footer">
    StockShift · Supplier catalogue reconciliation
    <span v-if="session">{{ session.user.email }}</span>
  </footer>
</template>
