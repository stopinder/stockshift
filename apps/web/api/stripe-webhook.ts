import type { IncomingMessage, ServerResponse } from "node:http";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { billingConfig, applyStripeEvent } from "../server/billing.ts";
import { serverConfigFromEnv } from "../server/supabase-upload-gateway.ts";
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.statusCode = 405;
    res.end("{}");
    return;
  }
  try {
    const cfg = billingConfig();
    const secret = process.env.STOCKSHIFT_STRIPE_WEBHOOK_SECRET;
    if (!secret?.startsWith("whsec_")) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") {
      res.statusCode = 400;
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const part of req) {
      const b = Buffer.from(part);
      size += b.length;
      if (size > 131072) {
        res.statusCode = 413;
        res.end("{}");
        return;
      }
      chunks.push(b);
    }
    const stripe = new Stripe(cfg.key);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        Buffer.concat(chunks),
        signature,
        secret,
      );
    } catch {
      res.statusCode = 400;
      res.end("{}");
      return;
    }
    if (event.livemode !== cfg.live) {
      res.statusCode = 400;
      res.end("{}");
      return;
    }
    const db = serverConfigFromEnv();
    const admin = createClient(db.url, db.secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    await applyStripeEvent(event, stripe, cfg.price, admin);
    res.statusCode = 200;
    res.end('{"received":true}');
  } catch {
    res.statusCode = 503;
    res.end("{}");
  }
}
