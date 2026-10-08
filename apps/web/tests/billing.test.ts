import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import Stripe from "stripe";
import {
  billingConfig,
  validatePrice,
  billingStatus,
  applyStripeEvent,
} from "../server/billing.ts";
import handler from "../api/stripe-webhook.ts";
import billingHandler from "../api/billing.ts";
function response() {
  let status = 0,
    body = "";
  return {
    res: {
      setHeader() {},
      set statusCode(v: number) {
        status = v;
      },
      get statusCode() {
        return status;
      },
      end(v: string) {
        body = v;
      },
    } as unknown as ServerResponse,
    read: () => ({ status, body }),
  };
}
test("billing is fail-closed and live/test keys cannot be mixed", () => {
  assert.throws(() => billingConfig({}), /not available/);
  const config = {
    STOCKSHIFT_BILLING_ENABLED: "1",
    STOCKSHIFT_STRIPE_MODE: "test",
    STOCKSHIFT_STRIPE_SECRET_KEY: "sk_test_example",
    STOCKSHIFT_STRIPE_PRICE_ID: "price_example",
    STOCKSHIFT_PUBLIC_ORIGIN: "https://stockshift.co",
  };
  assert.equal(billingConfig(config).live, false);
  assert.throws(() =>
    billingConfig({ ...config, STOCKSHIFT_STRIPE_MODE: "live" }),
  );
  assert.throws(() =>
    billingConfig({
      ...config,
      STOCKSHIFT_PUBLIC_ORIGIN: "https://attacker.example",
    }),
  );
});
test("foreign products, wrong prices and live mismatch cannot be purchased", () => {
  const price = {
    id: "price_expected",
    livemode: false,
    active: true,
    type: "recurring",
    currency: "gbp",
    unit_amount: 2900,
    recurring: { interval: "month", interval_count: 1 },
    product: {
      id: "prod_example",
      metadata: { app: "stockshift", plan: "csv-launch" },
    },
  } as unknown as Stripe.Price;
  assert.doesNotThrow(() =>
    validatePrice(price, { id: "price_expected", live: false }),
  );
  for (const change of [
    { currency: "usd" },
    { unit_amount: 29000 },
    { livemode: true },
    { active: false },
    { product: "prod_foreign" },
    { product: { metadata: { app: "other", plan: "csv-launch" } } },
  ])
    assert.throws(() =>
      validatePrice({ ...price, ...change } as Stripe.Price, {
        id: "price_expected",
        live: false,
      }),
    );
});
test("webhook rejects bad signatures before any database work", async () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      STOCKSHIFT_BILLING_ENABLED: "1",
      STOCKSHIFT_STRIPE_MODE: "test",
      STOCKSHIFT_STRIPE_SECRET_KEY: "sk_test_example",
      STOCKSHIFT_STRIPE_PRICE_ID: "price_example",
      STOCKSHIFT_PUBLIC_ORIGIN: "https://stockshift.co",
      STOCKSHIFT_STRIPE_WEBHOOK_SECRET: "whsec_example",
    });
    const req = Object.assign(
      Readable.from([Buffer.from('{"type":"customer.subscription.created"}')]),
      { method: "POST", headers: { "stripe-signature": "t=1,v1=bad" } },
    );
    const r = response();
    await handler(req as unknown as IncomingMessage, r.res);
    assert.equal(r.read().status, 400);
  } finally {
    for (const k of Object.keys(process.env))
      if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
  }
});
test("billing endpoints require authentication and do not expose configuration", async () => {
  const r = response();
  await billingHandler(
    {
      method: "POST",
      headers: {},
      body: { action: "checkout" },
    } as IncomingMessage & { body: unknown },
    r.res,
  );
  assert.equal(r.read().status, 401);
  assert.equal(r.read().body, '{"error":"Authentication required."}');
});

test("preview checkout returns are explicitly trusted and never use live keys", () => {
  const config = {
    STOCKSHIFT_BILLING_ENABLED: "1",
    STOCKSHIFT_STRIPE_MODE: "test",
    STOCKSHIFT_STRIPE_SECRET_KEY: "sk_test_example",
    STOCKSHIFT_STRIPE_PRICE_ID: "price_example",
    VERCEL_ENV: "preview",
    STOCKSHIFT_PUBLIC_ORIGIN:
      "https://stockshift-git-codex-customer-allowance-stopinders-projects.vercel.app",
  };
  assert.equal(billingConfig(config).origin, config.STOCKSHIFT_PUBLIC_ORIGIN);
  for (const origin of [
    "https://stockshift.co",
    "https://attacker.vercel.app",
    config.STOCKSHIFT_PUBLIC_ORIGIN + "/",
    "http://stockshift-git-codex-customer-allowance-stopinders-projects.vercel.app",
  ])
    assert.throws(() =>
      billingConfig({ ...config, STOCKSHIFT_PUBLIC_ORIGIN: origin }),
    );
  assert.throws(
    () =>
      billingConfig({
        ...config,
        STOCKSHIFT_STRIPE_MODE: "live",
        STOCKSHIFT_STRIPE_SECRET_KEY: "sk_live_example",
      }),
    /test mode/,
  );
  assert.throws(
    () => billingConfig({ ...config, VERCEL_ENV: "production" }),
    /return address/,
  );
});

test("owner status exposes only the subscription summary and refuses a different billing mode", async () => {
  const old = { ...process.env };
  try {
    Object.assign(process.env, {
      STOCKSHIFT_BILLING_ENABLED: "1",
      STOCKSHIFT_STRIPE_MODE: "test",
      STOCKSHIFT_STRIPE_SECRET_KEY: "sk_test_example",
      STOCKSHIFT_STRIPE_PRICE_ID: "price_example",
      STOCKSHIFT_PUBLIC_ORIGIN: "https://stockshift.co",
    });
    let live = false;
    const calls: string[] = [];
    const ctx = {
      tenant: "tenant-example",
      admin: {
        from(table: string) {
          return {
            select() {
              return {
                eq(column: string, tenant: string) {
                  calls.push(`${table}:${column}:${tenant}`);
                  return {
                    async maybeSingle() {
                      return {
                        error: null,
                        data:
                          table === "billing_accounts"
                            ? { tenant_id: tenant }
                            : {
                                status: "active",
                                period_end: "2026-11-08T00:00:00Z",
                                livemode: live,
                              },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Parameters<typeof billingStatus>[0];
    const result = await billingStatus(ctx);
    assert.deepEqual(result, {
      enabled: true,
      mode: "test",
      hasAccount: true,
      subscription: { status: "active", periodEnd: "2026-11-08T00:00:00Z" },
    });
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((call) => call.endsWith(":tenant_id:tenant-example")),
    );
    live = true;
    await assert.rejects(() => billingStatus(ctx), /separate workspace/);
    process.env.STOCKSHIFT_BILLING_ENABLED = "0";
    calls.length = 0;
    assert.equal((await billingStatus(ctx)).enabled, false);
    assert.equal(calls.length, 0);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

test("webhook synchronization uses current Stripe state instead of stale event data", async () => {
  let recorded: Record<string, unknown> | undefined;
  const admin = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  return { error: null, data: { tenant_id: "tenant-example" } };
                },
              };
            },
          };
        },
      };
    },
    async rpc(name: string, params: Record<string, unknown>) {
      assert.equal(name, "record_stockshift_subscription_v2");
      recorded = params;
      return { error: null };
    },
  } as unknown as Parameters<typeof applyStripeEvent>[3];
  const stripe = {
    subscriptions: {
      async list() {
        return {
          has_more: false,
          data: [
            {
              id: "sub_current",
              created: 2,
              status: "past_due",
              items: {
                data: [
                  {
                    price: { id: "price_example" },
                    current_period_start: 1791462000,
                    current_period_end: 1794140400,
                  },
                ],
              },
            },
          ],
        };
      },
    },
  } as unknown as Stripe;
  await applyStripeEvent(
    {
      id: "evt_stale",
      type: "invoice.paid",
      livemode: false,
      data: { object: { customer: "cus_example", status: "active" } },
    } as unknown as Stripe.Event,
    stripe,
    "price_example",
    admin,
  );
  assert.equal(recorded?.p_status, "past_due");
  assert.equal(recorded?.p_live, false);
  assert.equal(recorded?.p_subscription, "sub_current");
});
