import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import Stripe from "stripe";
import { billingConfig, validatePrice } from "../server/billing.ts";
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
