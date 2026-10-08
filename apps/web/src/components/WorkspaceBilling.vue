<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { Client } from "../workflow";
import {
  billingRequest,
  canCheckout,
  parseBillingStatus,
  stripeRedirect,
  type BillingStatus,
} from "../billing";
const props = defineProps<{
  client: Client;
  tenantId: string;
  isOwner: boolean;
  checkoutComplete: boolean;
}>();
const emit = defineEmits<{ refreshed: [] }>();
const status = ref<BillingStatus | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref("");
const abort = new AbortController();
let disposed = false,
  generation = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  attempts = 0;
const statusLabel = computed(
  () =>
    ({
      active: "Active",
      trialing: "Trialing",
      past_due: "Payment overdue",
      unpaid: "Unpaid",
      incomplete: "Payment incomplete",
      paused: "Paused",
      canceled: "Canceled",
      incomplete_expired: "Incomplete checkout expired",
    })[status.value?.subscription?.status ?? ""] ?? "No subscription",
);
const periodEnd = computed(() =>
  status.value?.subscription
    ? new Date(status.value.subscription.periodEnd).toLocaleDateString(
        undefined,
        { dateStyle: "medium" },
      )
    : "",
);
const confirmed = computed(() =>
  ["active", "trialing"].includes(status.value?.subscription?.status ?? ""),
);
async function refresh() {
  if (!props.isOwner || disposed || busy.value) return;
  clearTimeout(timer);
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const next = parseBillingStatus(
      await billingRequest(
        props.client,
        props.tenantId,
        "status",
        abort.signal,
      ),
    );
    if (disposed || current !== generation) return;
    status.value = next;
    emit("refreshed");
    if (
      props.checkoutComplete &&
      next.enabled &&
      !confirmed.value &&
      attempts++ < 5
    )
      timer = setTimeout(() => void refresh(), 2000);
  } catch (e) {
    if (!disposed && current === generation) {
      status.value = null;
      error.value =
        e instanceof Error
          ? e.message
          : "Billing service unavailable. Try again.";
    }
  } finally {
    if (!disposed && current === generation) loading.value = false;
  }
}
async function openStripe(action: "checkout" | "portal") {
  if (busy.value || loading.value || !status.value?.enabled || !props.isOwner)
    return;
  if (action === "checkout" && !canCheckout(status.value)) return;
  busy.value = true;
  error.value = "";
  generation++;
  clearTimeout(timer);
  try {
    const result = (await billingRequest(
      props.client,
      props.tenantId,
      action,
      abort.signal,
    )) as { url?: unknown };
    if (!disposed) location.assign(stripeRedirect(result.url));
  } catch (e) {
    if (!disposed)
      error.value =
        e instanceof Error
          ? e.message
          : "Stripe could not be opened. Try again.";
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(() => void refresh());
onUnmounted(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
  abort.abort();
});
</script>
<template>
  <section
    class="panel billing-panel"
    aria-label="Workspace billing"
    :aria-busy="loading || busy"
  >
    <div class="page-heading">
      <div>
        <p class="eyebrow">Workspace subscription</p>
        <h1>Billing</h1>
      </div>
      <a class="button quiet" href="#/comparisons">Back to comparisons</a>
    </div>
    <p v-if="!isOwner" class="muted">
      Only a workspace owner can view and manage billing. Ask your workspace
      owner about your subscription.
    </p>
    <template v-else>
      <p v-if="loading" role="status">Checking subscription…</p>
      <p v-if="error" class="alert" role="alert">{{ error }}</p>
      <p v-if="status && !status.enabled" class="alert" role="status">
        Paid subscriptions are not available yet. Your saved comparisons remain
        accessible.
      </p>
      <template v-if="status?.enabled">
        <p v-if="status.mode === 'test'" class="alert" role="status">
          <strong>Test billing — no real charges.</strong> Use a separate test
          workspace and Stripe test cards. Test subscriptions do not increase
          the comparison allowance in the shared workspace service.
        </p>
        <p v-if="checkoutComplete" class="hint" role="status">
          {{
            confirmed
              ? "Your subscription has been confirmed."
              : "You have returned from Checkout. Waiting for Stripe to confirm your subscription. Refresh status if confirmation takes longer."
          }}
        </p>
        <dl class="billing-summary">
          <div>
            <dt>Plan</dt>
            <dd>StockShift CSV · £29 / month</dd>
          </div>
          <div>
            <dt>Subscription</dt>
            <dd>{{ statusLabel }}</dd>
          </div>
          <div v-if="periodEnd">
            <dt>Current period ends</dt>
            <dd>{{ periodEnd }}</dd>
          </div>
        </dl>
        <p class="muted">
          20 comparisons per active monthly subscription period. A comparison
          counts when processing is queued. Review and export of saved results
          remain available.
        </p>
        <p
          v-if="
            status.subscription &&
            ['past_due', 'unpaid', 'incomplete', 'paused'].includes(
              status.subscription.status,
            )
          "
          class="alert"
        >
          Your subscription needs attention. Open billing management to review
          your payment details.
        </p>
        <div class="billing-actions">
          <button
            v-if="canCheckout(status)"
            class="primary"
            :disabled="busy || loading"
            @click="openStripe('checkout')"
          >
            {{
              busy
                ? "Opening Stripe…"
                : status.mode === "test"
                  ? "Start test checkout"
                  : "Subscribe for £29 / month"
            }}
          </button>
          <button
            v-if="status.hasAccount"
            :disabled="busy || loading"
            @click="openStripe('portal')"
          >
            {{ busy ? "Opening Stripe…" : "Manage subscription" }}
          </button>
        </div>
        <p class="hint">
          Manage payment details, invoices and cancellation in Stripe.
          Subscription changes are confirmed through Stripe before the workspace
          status updates.
        </p>
      </template>
      <button class="quiet" :disabled="loading || busy" @click="refresh">
        Refresh subscription status
      </button>
    </template>
  </section>
</template>
