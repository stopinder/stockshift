import type { Client } from "./workflow";
export const subscriptionStatuses = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
  "canceled",
  "incomplete_expired",
] as const;
export interface BillingStatus {
  enabled: boolean;
  mode: "test" | "live" | null;
  hasAccount: boolean;
  subscription: { status: string; periodEnd: string } | null;
}
export function parseBillingStatus(value: unknown): BillingStatus {
  const s = value as BillingStatus | null;
  if (
    !s ||
    typeof s.enabled !== "boolean" ||
    typeof s.hasAccount !== "boolean" ||
    (s.enabled ? !["test", "live"].includes(s.mode ?? "") : s.mode !== null) ||
    (s.subscription !== null &&
      (!s.subscription ||
        !subscriptionStatuses.includes(
          s.subscription.status as (typeof subscriptionStatuses)[number],
        ) ||
        typeof s.subscription.periodEnd !== "string" ||
        !Number.isFinite(Date.parse(s.subscription.periodEnd))))
  )
    throw new Error("Subscription status unavailable. Try refreshing.");
  return s;
}
export function canCheckout(status: BillingStatus): boolean {
  return (
    status.enabled &&
    (!status.subscription ||
      ["canceled", "incomplete_expired"].includes(status.subscription.status))
  );
}
export function stripeRedirect(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Stripe could not be opened. Try again.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)
  )
    throw new Error("Stripe could not be opened. Try again.");
  return url.href;
}
export async function billingRequest(
  client: Client,
  tenantId: string,
  action: "status" | "checkout" | "portal",
  signal?: AbortSignal,
): Promise<unknown> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session)
    throw new Error("Sign in again to manage billing.");
  const response = await fetch("/api/billing", {
    method: "POST",
    signal: signal ?? null,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({ action, tenantId }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "Billing service unavailable. Try again.");
  return result;
}
