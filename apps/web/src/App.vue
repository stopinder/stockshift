<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Session } from "@supabase/supabase-js";
import { browserClient, friendlyError } from "./workflow";
import LandingPage from "./components/LandingPage.vue";
import ComparisonList from "./components/ComparisonList.vue";
import NewComparison from "./components/NewComparison.vue";
import ComparisonDetail from "./components/ComparisonDetail.vue";
import WorkspaceAllowance from "./components/WorkspaceAllowance.vue";
import WorkspaceBilling from "./components/WorkspaceBilling.vue";
import NewWorkspace from "./components/NewWorkspace.vue";
import { useAllowance } from "./allowance";
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
  route = ref(location.hash.slice(1) || "/");
const registrationEnabled =
  import.meta.env.VITE_STOCKSHIFT_REGISTRATION_ENABLED === "1";
const notice = ref("");
const billingTestMode =
  import.meta.env.VITE_STOCKSHIFT_BILLING_TEST_MODE === "1";
const recovering = ref(
  new URLSearchParams(location.hash.slice(1)).get("type") === "recovery",
);
const authMode = computed(() =>
  route.value === "/signup"
    ? "signup"
    : route.value === "/forgot-password"
      ? "forgot"
      : "login",
);
const tenants = ref<{ id: string; name: string; role: string }[]>([]),
  tenantId = ref("");
const allowance = useAllowance(client, tenantId);
const tenant = computed(() =>
  tenants.value.find((t) => t.id === tenantId.value),
);
const canEdit = computed(() =>
  ["owner", "editor"].includes(tenant.value?.role ?? ""),
);
const comparisonId = computed(
  () => /^\/comparisons\/([0-9a-f-]{36})$/.exec(route.value)?.[1],
);
const billingRoute = computed(() => route.value.split("?")[0] === "/billing");
const checkoutComplete = computed(
  () =>
    new URLSearchParams(route.value.split("?")[1]).get("checkout") ===
    "complete",
);
function hashChanged() {
  route.value = location.hash.slice(1) || "/";
  error.value = "";
  void allowance.refresh();
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
async function authenticate() {
  if (!client) return;
  if (authMode.value === "signup" && !registrationEnabled) return;
  if (authMode.value === "login") {
    await signIn();
    return;
  }
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    if (authMode.value === "forgot") {
      const result = await client.auth.resetPasswordForEmail(email.value, {
        redirectTo: `${location.origin}/#/reset-password`,
      });
      if (result.error)
        throw new Error(
          "We could not send the reset email. Please try again later.",
        );
      notice.value =
        "If an account exists for this email, you will receive a password reset link.";
    } else {
      const result = await client.auth.signUp({
        email: email.value,
        password: password.value,
        options: { emailRedirectTo: `${location.origin}/#/comparisons` },
      });
      if (result.error)
        throw new Error(
          "Account creation could not be completed. Try signing in if you already have an account.",
        );
      password.value = "";
      if (result.data.session) {
        session.value = result.data.session;
        await memberships();
        navigate("/comparisons");
      } else
        notice.value =
          "Check your email to confirm your account, then sign in to create your workspace.";
    }
  } catch (e) {
    error.value = friendlyError(e);
  } finally {
    busy.value = false;
  }
}
async function workspaceCreated(id: string, requiresSubscription: boolean) {
  await memberships();
  if (!tenants.value.some((t) => t.id === id)) {
    error.value =
      "Workspace created, but its membership could not be reloaded. Refresh the page to try again.";
    return;
  }
  tenantId.value = id;
  localStorage.setItem("stockshift.tenant", id);
  navigate(requiresSubscription ? "/billing" : "/comparisons");
}
async function updatePassword() {
  if (!client || !recovering.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await client.auth.updateUser({ password: password.value });
    if (result.error)
      throw new Error(
        "Password update failed. Request a new reset link and try again.",
      );
    password.value = "";
    recovering.value = false;
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
      if (event === "PASSWORD_RECOVERY") {
        recovering.value = true;
        navigate("/reset-password");
      }
      if (event === "SIGNED_IN")
        setTimeout(() => {
          void memberships();
        }, 0);
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
    <a class="brand" href="#/"
      ><span class="brand-mark" aria-hidden="true">S</span>StockShift</a
    >
    <template v-if="session">
      <nav aria-label="Main navigation">
        <a
          href="#/comparisons"
          :aria-current="route === '/comparisons' ? 'page' : undefined"
          >Comparisons</a
        >
        <a href="#/billing" :aria-current="billingRoute ? 'page' : undefined"
          >Billing</a
        >
      </nav>
      <div class="header-account">
        <div class="workspace-control">
          <label v-if="tenants.length > 1" for="workspace">Workspace</label>
          <span v-else class="muted">Workspace</span>
          <select
            v-if="tenants.length > 1"
            id="workspace"
            v-model="tenantId"
            @change="changeTenant"
          >
            <option v-for="t in tenants" :key="t.id" :value="t.id">
              {{ t.name }}
            </option>
          </select>
          <span v-else class="workspace-name">{{
            tenant?.name ?? "None selected"
          }}</span>
        </div>
        <a class="button quiet" href="#/workspaces/new">Create workspace</a>
        <button class="quiet" @click="signOut">Sign out</button>
      </div>
    </template>
    <a v-else class="button quiet" href="#/login">Sign in</a>
  </header>
  <main
    id="main"
    :class="['app-main', { 'marketing-main': !session && route === '/' }]"
    tabindex="-1"
  >
    <LandingPage
      v-if="!session && route === '/'"
      :registration-enabled="registrationEnabled"
    />
    <p v-else-if="!ready" role="status" class="state">
      Loading your workspace…
    </p>
    <section v-else-if="configError" class="panel auth-panel">
      <h1>Workspace unavailable</h1>
      <p>{{ configError }}</p>
    </section>
    <section v-else-if="!session" class="panel auth-panel">
      <p class="eyebrow">Your catalogue workspace</p>
      <h1>
        {{
          authMode === "signup"
            ? "Create your account"
            : authMode === "forgot"
              ? "Reset your password"
              : "Welcome back"
        }}
      </h1>
      <p class="muted">
        {{
          authMode === "signup"
            ? "Create an account, confirm your email and set up your business workspace."
            : authMode === "forgot"
              ? "We’ll email you a secure reset link."
              : "Sign in to compare supplier files and review changes."
        }}
      </p>
      <p
        v-if="authMode === 'signup' && !registrationEnabled"
        role="status"
        class="alert"
      >
        Public registration is not open yet. Existing users can sign in.
        Customer onboarding is being prepared.
      </p>
      <form v-else @submit.prevent="authenticate">
        <label
          >Email<input
            v-model="email"
            type="email"
            autocomplete="username"
            required
        /></label>
        <label v-if="authMode !== 'forgot'"
          >Password<input
            v-model="password"
            type="password"
            :autocomplete="
              authMode === 'signup' ? 'new-password' : 'current-password'
            "
            :minlength="authMode === 'signup' ? 12 : undefined"
            required
        /></label>
        <p v-if="authMode === 'signup'" class="muted">
          Use at least 12 characters. Email confirmation is required.
        </p>
        <p v-if="error" role="alert" class="alert">{{ error }}</p>
        <p v-if="notice" role="status" class="alert">{{ notice }}</p>
        <button class="primary" :disabled="busy">
          {{
            busy
              ? "Please wait…"
              : authMode === "signup"
                ? "Create account"
                : authMode === "forgot"
                  ? "Send reset link"
                  : "Sign in"
          }}
        </button>
      </form>
      <p v-if="authMode === 'login'">
        <a href="#/forgot-password">Forgot your password?</a> ·
        <a href="#/signup">Create an account</a>
      </p>
      <p v-else><a href="#/login">Back to sign in</a></p>
    </section>
    <section v-else-if="recovering" class="panel auth-panel">
      <h1>Choose a new password</h1>
      <form @submit.prevent="updatePassword">
        <label
          >New password<input
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="12"
            required
        /></label>
        <p v-if="error" role="alert" class="alert">{{ error }}</p>
        <button class="primary" :disabled="busy">Save password</button>
      </form>
    </section>
    <template v-else>
      <p v-if="error" role="alert" class="alert">{{ error }}</p>
      <NewWorkspace
        v-if="client && (route === '/workspaces/new' || !tenant)"
        :client="client"
        :test-mode="billingTestMode"
        :has-workspace="tenants.length > 0"
        @created="workspaceCreated"
      />
      <template v-else-if="client && tenant"
        ><div class="workspace-line">
          {{ tenant.name }} <span class="badge">{{ tenant.role }}</span>
        </div>
        <WorkspaceAllowance
          :allowance="allowance.value.value"
          :loading="allowance.loading.value"
          :error="allowance.error.value"
          @refresh="allowance.refresh"
        />
        <WorkspaceBilling
          v-if="billingRoute"
          :key="`${tenantId}:${route}`"
          :client="client"
          :tenant-id="tenantId"
          :is-owner="tenant.role === 'owner'"
          :checkout-complete="checkoutComplete"
          @refreshed="allowance.refresh"
        />
        <NewComparison
          v-else-if="route === '/comparisons/new' && canEdit"
          :key="tenantId"
          :client="client"
          :tenant-id="tenantId"
          :can-create="allowance.canCreate.value"
          :check-allowance="allowance.refresh"
          @created="(id) => navigate(`/comparisons/${id}`)"
        />
        <ComparisonDetail
          v-else-if="comparisonId"
          :key="`${tenantId}:${comparisonId}`"
          :client="client"
          :tenant-id="tenantId"
          :comparison-id="comparisonId"
          :allowance="allowance.value.value"
          :allowance-loading="allowance.loading.value"
          :check-allowance="allowance.refresh"
          :can-edit="canEdit"
        />
        <ComparisonList
          v-else
          :key="tenantId"
          :client="client"
          :tenant-id="tenantId"
          :can-create="allowance.canCreate.value"
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
