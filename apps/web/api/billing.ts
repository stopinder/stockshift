import type { IncomingMessage, ServerResponse } from "node:http";
import { BillingError, billingAction } from "../server/billing.ts";
export default async function handler(
  req: IncomingMessage & { body?: unknown },
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
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new BillingError(401, "Authentication required.");
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      throw new BillingError(400, "Expected JSON body.");
    const output = await billingAction(
      authorization.slice(7),
      req.body as Record<string, unknown>,
    );
    res.statusCode = 200;
    res.end(JSON.stringify(output));
  } catch (e) {
    res.statusCode = e instanceof BillingError ? e.status : 503;
    res.end(
      JSON.stringify({
        error:
          e instanceof BillingError
            ? e.message
            : "Billing service unavailable.",
      }),
    );
  }
}
