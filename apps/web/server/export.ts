import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serverConfigFromEnv } from "./supabase-upload-gateway.ts";
import { UploadError } from "./uploads.ts";

export const EXPORT_COLUMNS = [
  "supplier_sku",
  "description",
  "currency",
  "unit",
  "pack_quantity",
  "price_basis",
  "tax_basis",
  "old_cost",
  "new_cost",
  "cost_delta",
  "cost_change_percent",
  "percentage_state",
  "change_flags",
] as const;
const decimals = new Set([
  "pack_quantity",
  "old_cost",
  "new_cost",
  "cost_delta",
  "cost_change_percent",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function changedProductsCsv(rows: Record<string, unknown>[]): string {
  const cell = (key: string, raw: unknown): string => {
    let value =
      raw == null ? "" : Array.isArray(raw) ? raw.join(";") : String(raw);
    if (decimals.has(key)) {
      if (value && !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value))
        throw new Error("Invalid persisted decimal");
    } else if (
      /^[\s\u0000-\u001f\u007f-\u009f\ufeff]*[=+@-]/u.test(value) ||
      /^[\t\r\n]/.test(value)
    )
      value = `'${value}`;
    return `"${value.replaceAll('"', '""')}"`;
  };
  return `${EXPORT_COLUMNS.join(",")}\r\n${rows.map((row) => EXPORT_COLUMNS.map((key) => cell(key, row[key])).join(",")).join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

export default async function exportHandler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      throw new UploadError(405, "Use GET");
    }
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (!token || token.length > 8192)
      throw new UploadError(401, "Sign in again to export");
    const url = new URL(req.url ?? "", "http://localhost");
    const tenant = url.searchParams.get("tenant"),
      run = url.searchParams.get("run");
    if (!tenant || !run || !uuid.test(tenant) || !uuid.test(run))
      throw new UploadError(400, "Invalid export selection");
    const config = serverConfigFromEnv();
    // User JWT applies to export. No privileged client reads comparison results.
    const client = createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const identity = await client.auth.getUser(token);
    if (
      identity.error ||
      !identity.data.user ||
      identity.data.user.is_anonymous
    )
      throw new UploadError(401, "Sign in again to export");
    const { data, error } = await client.rpc("csv_export_rows", {
      p_tenant: tenant,
      p_run: run,
    });
    if (error)
      throw new UploadError(
        error.code === "42501" ? 403 : 409,
        error.code === "42501"
          ? "You cannot export this comparison"
          : "Complete processing and resolve all review items before exporting",
      );
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="changed_products.csv"',
    );
    res.end(changedProductsCsv(data));
  } catch (error) {
    res.statusCode = error instanceof UploadError ? error.status : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error:
          error instanceof UploadError
            ? error.message
            : "Export unavailable. Try again shortly.",
      }),
    );
  }
}
