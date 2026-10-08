import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBillingStatus,
  canCheckout,
  stripeRedirect,
} from "../src/billing.ts";
test("subscription lifecycle prevents a second checkout while payment needs attention", () => {
  for (const status of [
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "paused",
  ])
    assert.equal(
      canCheckout(
        parseBillingStatus({
          enabled: true,
          mode: "test",
          hasAccount: true,
          subscription: { status, periodEnd: "2026-11-08T00:00:00Z" },
        }),
      ),
      false,
    );
  for (const status of ["canceled", "incomplete_expired"])
    assert.equal(
      canCheckout(
        parseBillingStatus({
          enabled: true,
          mode: "test",
          hasAccount: true,
          subscription: { status, periodEnd: "2026-11-08T00:00:00Z" },
        }),
      ),
      true,
    );
  assert.equal(
    canCheckout(
      parseBillingStatus({
        enabled: false,
        mode: null,
        hasAccount: false,
        subscription: null,
      }),
    ),
    false,
  );
});
test("only HTTPS Stripe checkout and portal destinations are accepted", () => {
  for (const url of [
    "https://checkout.stripe.com/c/pay/cs_test_example",
    "https://billing.stripe.com/p/session/example",
  ])
    assert.equal(stripeRedirect(url), url);
  for (const url of [
    "http://checkout.stripe.com/a",
    "https://checkout.stripe.com.attacker.example",
    "https://attacker@checkout.stripe.com/a",
    "javascript:alert(1)",
    "https://checkout.stripe.com:8443/a",
    null,
  ])
    assert.throws(() => stripeRedirect(url));
});
test("invalid status payload cannot activate the purchase controls", () => {
  for (const value of [
    null,
    {},
    { enabled: true, mode: "unknown", hasAccount: true, subscription: null },
    {
      enabled: true,
      mode: "test",
      hasAccount: true,
      subscription: { status: "made_up", periodEnd: "2026-11-08" },
    },
    {
      enabled: true,
      mode: "test",
      hasAccount: true,
      subscription: { status: "active", periodEnd: "bad" },
    },
  ])
    assert.throws(() => parseBillingStatus(value));
});
