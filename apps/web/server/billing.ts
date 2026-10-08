import Stripe from "stripe";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverConfigFromEnv } from "./supabase-upload-gateway.ts";
export class BillingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function billingConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.STOCKSHIFT_BILLING_ENABLED !== "1")
    throw new BillingError(503, "Paid subscriptions are not available yet.");
  const key = env.STOCKSHIFT_STRIPE_SECRET_KEY ?? "";
  const mode = env.STOCKSHIFT_STRIPE_MODE;
  if (
    !["test", "live"].includes(mode ?? "") ||
    !(mode === "live" ? /^(?:sk|rk)_live_/ : /^(?:sk|rk)_test_/).test(key)
  )
    throw new BillingError(503, "Billing configuration unavailable.");
  const origin = env.STOCKSHIFT_PUBLIC_ORIGIN ?? "";
  const preview = env.VERCEL_ENV === "preview";
  if (preview && mode !== "test")
    throw new BillingError(503, "Preview billing requires test mode.");
  const allowedOrigin = preview
    ? "https://stockshift-git-codex-customer-allowance-stopinders-projects.vercel.app"
    : "https://stockshift.co";
  if (origin !== allowedOrigin)
    throw new BillingError(503, "Billing return address unavailable.");
  const price = env.STOCKSHIFT_STRIPE_PRICE_ID ?? "";
  if (!/^price_[A-Za-z0-9]+$/.test(price))
    throw new BillingError(503, "Billing plan unavailable.");
  return { key, price, origin, live: mode === "live" };
}
export async function ownerContext(token: string, tenant: unknown) {
  if (
    typeof tenant !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(tenant)
  )
    throw new BillingError(400, "Workspace required.");
  const cfg = serverConfigFromEnv();
  const admin = createClient(cfg.url, cfg.secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const identity = await admin.auth.getUser(token);
  if (identity.error || !identity.data.user || identity.data.user.is_anonymous)
    throw new BillingError(401, "Sign in again.");
  const membership = await admin
    .from("tenant_memberships")
    .select("role")
    .eq("tenant_id", tenant)
    .eq("user_id", identity.data.user.id)
    .maybeSingle();
  if (membership.error || membership.data?.role !== "owner")
    throw new BillingError(403, "Only a workspace owner can manage billing.");
  const workspace = await admin
    .from("workspace_allowances")
    .select("test_workspace")
    .eq("tenant_id", tenant)
    .single();
  if (workspace.error)
    throw new BillingError(503, "Billing workspace unavailable.");
  return {
    admin,
    tenant,
    user: identity.data.user,
    testWorkspace: workspace.data.test_workspace,
  };
}
export function validatePrice(
  price: Stripe.Price,
  expected: { id: string; live: boolean },
) {
  const product = price.product;
  if (
    price.id !== expected.id ||
    price.livemode !== expected.live ||
    !price.active ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.currency !== "gbp" ||
    price.unit_amount !== 2900 ||
    typeof product === "string" ||
    product.deleted ||
    product.metadata.app !== "stockshift" ||
    product.metadata.plan !== "csv-launch"
  )
    throw new BillingError(503, "Billing plan is not approved.");
}
export async function billingStatus(
  ctx: Awaited<ReturnType<typeof ownerContext>>,
) {
  let cfg: ReturnType<typeof billingConfig>;
  try {
    cfg = billingConfig();
  } catch (e) {
    if (e instanceof BillingError && e.status === 503)
      return {
        enabled: false,
        mode: null,
        hasAccount: false,
        subscription: null,
      };
    throw e;
  }
  if (ctx.testWorkspace && cfg.live)
    throw new BillingError(
      409,
      "Test workspaces cannot receive live payments.",
    );
  const account = await ctx.admin
    .from("billing_accounts")
    .select("tenant_id")
    .eq("tenant_id", ctx.tenant)
    .maybeSingle();
  const subscription = await ctx.admin
    .from("workspace_subscriptions")
    .select("status,period_end,livemode")
    .eq("tenant_id", ctx.tenant)
    .maybeSingle();
  if (account.error || subscription.error)
    throw new BillingError(503, "Subscription status unavailable.");
  if (subscription.data && subscription.data.livemode !== cfg.live)
    throw new BillingError(409, "Use a separate workspace for test billing.");
  return {
    enabled: true,
    mode: cfg.live ? "live" : "test",
    hasAccount: !!account.data,
    subscription: subscription.data
      ? {
          status: subscription.data.status,
          periodEnd: subscription.data.period_end,
        }
      : null,
  };
}
export async function billingAction(
  token: string,
  input: Record<string, unknown>,
) {
  const ctx = await ownerContext(token, input.tenantId);
  if (input.action === "status") return billingStatus(ctx);
  const cfg = billingConfig();
  if (ctx.testWorkspace && cfg.live)
    throw new BillingError(
      409,
      "Test workspaces cannot receive live payments.",
    );
  const stripe = new Stripe(cfg.key);
  const price = await stripe.prices.retrieve(cfg.price, {
    expand: ["product"],
  });
  validatePrice(price, { id: cfg.price, live: cfg.live });
  const customer = await ctx.admin
    .from("billing_accounts")
    .select("stripe_customer_id")
    .eq("tenant_id", ctx.tenant)
    .maybeSingle();
  if (customer.error)
    throw new BillingError(503, "Billing workspace unavailable.");
  const existing = await ctx.admin
    .from("workspace_subscriptions")
    .select("status,livemode")
    .eq("tenant_id", ctx.tenant)
    .maybeSingle();
  if (existing.error)
    throw new BillingError(503, "Subscription status unavailable.");
  if (existing.data && existing.data.livemode !== cfg.live)
    throw new BillingError(409, "Use a separate workspace for test billing.");
  if (input.action === "portal") {
    if (!customer.data)
      throw new BillingError(409, "This workspace has no billing account.");
    const configuration = process.env.STOCKSHIFT_STRIPE_PORTAL_CONFIGURATION_ID;
    if (!configuration || !/^bpc_[A-Za-z0-9]+$/.test(configuration))
      throw new BillingError(
        503,
        "Subscription management is not available yet.",
      );
    const portal = await stripe.billingPortal.sessions.create({
      configuration,
      customer: customer.data.stripe_customer_id,
      return_url: `${cfg.origin}/#/billing`,
    });
    return { url: portal.url };
  }
  if (input.action !== "checkout")
    throw new BillingError(400, "Unknown billing action.");
  if (
    existing.data &&
    [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "paused",
    ].includes(existing.data.status)
  )
    throw new BillingError(
      409,
      "Manage your existing subscription from billing.",
    );
  let customerId = customer.data?.stripe_customer_id;
  if (!customerId) {
    const created = await stripe.customers.create(
      {
        ...(ctx.user.email ? { email: ctx.user.email } : {}),
        metadata: { app: "stockshift", tenant_id: ctx.tenant },
      },
      { idempotencyKey: `stockshift-customer-${ctx.tenant}` },
    );
    const saved = await ctx.admin
      .from("billing_accounts")
      .upsert(
        { tenant_id: ctx.tenant, stripe_customer_id: created.id },
        { onConflict: "tenant_id", ignoreDuplicates: true },
      );
    if (saved.error)
      throw new BillingError(503, "Billing account could not be saved.");
    const reread = await ctx.admin
      .from("billing_accounts")
      .select("stripe_customer_id")
      .eq("tenant_id", ctx.tenant)
      .single();
    if (reread.error)
      throw new BillingError(503, "Billing account unavailable.");
    customerId = reread.data.stripe_customer_id;
  }
  const checkout = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      integration_identifier: "stockshift_csv_xgvrkqna",
      customer: customerId,
      line_items: [{ price: cfg.price, quantity: 1 }],
      success_url: `${cfg.origin}/#/billing?checkout=complete`,
      cancel_url: `${cfg.origin}/#/billing`,
      client_reference_id: ctx.tenant,
      subscription_data: {
        metadata: { app: "stockshift", tenant_id: ctx.tenant },
      },
    },
    {
      idempotencyKey: `stockshift-checkout-${ctx.tenant}-${Math.floor(Date.now() / 1800000)}`,
    },
  );
  if (!checkout.url) throw new BillingError(503, "Checkout unavailable.");
  return { url: checkout.url };
}
export async function applyStripeEvent(
  event: Stripe.Event,
  stripe: Stripe,
  priceId: string,
  admin: SupabaseClient,
) {
  if (
    ![
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "invoice.paid",
      "invoice.payment_failed",
    ].includes(event.type)
  )
    return;
  const object = event.data.object as unknown as {
    customer?: string | { id: string };
    id: string;
    object: string;
  };
  const customer =
    typeof object.customer === "string" ? object.customer : object.customer?.id;
  if (!customer) return;
  const mapping = await admin
    .from("billing_accounts")
    .select("tenant_id")
    .eq("stripe_customer_id", customer)
    .maybeSingle();
  if (mapping.error) throw new Error("Billing lookup failed");
  if (!mapping.data) return;
  // Current Stripe state is authoritative, not webhook arrival order or caller metadata.
  const subscriptions = await stripe.subscriptions.list({
    customer,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price"],
  });
  if (subscriptions.has_more)
    throw new Error("Subscription set exceeds safety limit");
  const relevant = subscriptions.data.filter(
    (s) => s.items.data.length === 1 && s.items.data[0]?.price.id === priceId,
  );
  const active = relevant.filter((s) =>
    [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "paused",
    ].includes(s.status),
  );
  if (active.length > 1)
    throw new Error("Multiple subscriptions require investigation");
  const subscription =
    active[0] ?? relevant.sort((a, b) => b.created - a.created)[0];
  if (!subscription) return;
  const item = subscription.items.data[0]!;
  const result = await admin.rpc("record_stockshift_subscription_v2", {
    p_event: event.id,
    p_tenant: mapping.data.tenant_id,
    p_customer: customer,
    p_subscription: subscription.id,
    p_status: subscription.status,
    p_period_start: new Date(item.current_period_start * 1000).toISOString(),
    p_period_end: new Date(item.current_period_end * 1000).toISOString(),
    p_live: event.livemode,
  });
  if (result.error) throw new Error("Subscription update failed");
}
