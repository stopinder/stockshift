import { computed, onScopeDispose, ref, watch, type Ref } from "vue";
import type { Client } from "./workflow";
export interface Allowance {
  plan: "pilot" | "trial" | "paid" | "subscription_required";
  test_workspace?: boolean;
  comparisons_remaining: number | null;
  comparison_limit: number | null;
  uploads_remaining: number | null;
  upload_limit: number | null;
  bytes_remaining: number | null;
  byte_limit: number | null;
  period_end: string | null;
}
export function parseAllowance(value: unknown): Allowance {
  const a = value as Allowance | null;
  if (
    !a ||
    !["pilot", "trial", "paid", "subscription_required"].includes(a.plan)
  )
    throw new Error("Invalid allowance");
  const pairs = [
    [a.comparisons_remaining, a.comparison_limit],
    [a.uploads_remaining, a.upload_limit],
    [a.bytes_remaining, a.byte_limit],
  ];
  if (
    a.plan === "subscription_required" &&
    (pairs.some(([remaining]) => remaining !== 0) ||
      typeof a.test_workspace !== "boolean")
  )
    throw new Error("Invalid allowance");
  if (a.plan === "pilot") {
    if (
      pairs.some((pair) => pair.some((v) => v !== null)) ||
      a.period_end !== null
    )
      throw new Error("Invalid allowance");
  } else {
    if (
      pairs.some(
        ([remaining, limit]) =>
          !Number.isSafeInteger(remaining) ||
          !Number.isSafeInteger(limit) ||
          remaining! < 0 ||
          limit! <= 0 ||
          remaining! > limit!,
      )
    )
      throw new Error("Invalid allowance");
    if (
      a.plan === "paid"
        ? typeof a.period_end !== "string" ||
          !Number.isFinite(Date.parse(a.period_end))
        : a.period_end !== null
    )
      throw new Error("Invalid allowance");
  }
  return a;
}
export function canCompare(a: Allowance | null): boolean {
  return !!a && (a.plan === "pilot" || a.comparisons_remaining! > 0);
}
export function canUpload(a: Allowance | null, bytes = 1): boolean {
  return (
    canCompare(a) &&
    (a!.plan === "pilot" ||
      (a!.uploads_remaining! > 0 && a!.bytes_remaining! >= bytes))
  );
}
export function canStartDraft(a: Allowance | null): boolean {
  return canUpload(a) && (a!.plan === "pilot" || a!.uploads_remaining! >= 2);
}
export function useAllowance(client: Client | null, tenantId: Ref<string>) {
  const value = ref<Allowance | null>(null),
    loading = ref(false),
    error = ref("");
  let request = 0,
    disposed = false;
  async function refresh(): Promise<Allowance | null> {
    const current = ++request,
      tenant = tenantId.value;
    if (!client || !tenant) {
      value.value = null;
      loading.value = false;
      return null;
    }
    loading.value = true;
    error.value = "";
    try {
      const result = await client.rpc("workspace_allowance_status", {
        p_tenant: tenant,
      });
      if (result.error) throw result.error;
      const next = parseAllowance(result.data);
      if (disposed || current !== request || tenant !== tenantId.value)
        return null;
      value.value = next;
      return next;
    } catch {
      if (!disposed && current === request) {
        value.value = null;
        error.value =
          "We couldn’t check your workspace allowance. Retry before uploading or starting a comparison. Saved results remain available.";
      }
      return null;
    } finally {
      if (!disposed && current === request) loading.value = false;
    }
  }
  watch(
    tenantId,
    () => {
      value.value = null;
      void refresh();
    },
    { immediate: true, flush: "sync" },
  );
  onScopeDispose(() => {
    disposed = true;
    request++;
  });
  return {
    value,
    loading,
    error,
    refresh,
    canCreate: computed(() => !loading.value && canStartDraft(value.value)),
  };
}
