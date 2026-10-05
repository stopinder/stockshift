import { createClient } from "@supabase/supabase-js";

export function validateBrowserConfig(url: string, key: string) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.port !== "54321" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !key
  )
    throw new Error("Local Supabase configuration required");
  if (key.startsWith("sb_secret_"))
    throw new Error("Browser requires a publishable key");
  if (key.split(".").length === 3) {
    const payload = JSON.parse(
      atob(key.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    );
    if (payload.role !== "anon")
      throw new Error("Browser requires an anonymous public key");
  } else if (!key.startsWith("sb_publishable_"))
    throw new Error("Browser requires a publishable key");
  return { url, key };
}
export function browserClient() {
  const config = validateBrowserConfig(
    import.meta.env.VITE_STOCKSHIFT_LOCAL_SUPABASE_URL ?? "",
    import.meta.env.VITE_STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY ?? "",
  );
  return createClient(config.url, config.key);
}
export type Client = ReturnType<typeof browserClient>;
export type Product = Record<string, string | null> & {
  supplier_sku: string | null;
  description: string | null;
};
export interface SourceEvidence {
  evidence_id: string;
  source_file_id: string;
  field_name: string;
  raw_text: string;
  locator: { row: number | null; column: string | null };
}
export interface ResultRow {
  id: string;
  primary_outcome: string;
  review_state: string;
  change_flags: string[];
  old_values: Product | null;
  new_values: Product | null;
  cost_delta_text: string | null;
  cost_change_percent_text: string | null;
  percentage_state: string;
  reasons: { code: string; message: string }[];
  provenance: SourceEvidence[];
  decision: string | null;
  note: string | null;
  reviewed_at: string | null;
}
export const outcomeLabels: Record<string, string> = {
  unchanged: "Unchanged",
  changed: "Changed",
  new: "New",
  absent: "Absent",
  needs_review: "Needs review",
};
export function friendlyError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "42501")
    return "You do not have access. Choose an authorised workspace or ask its owner.";
  if (
    code === "PGRST301" ||
    code === "bad_jwt" ||
    code === "refresh_token_not_found"
  )
    return "Your session expired. Sign out and sign in again.";
  if (code === "23514" || code === "23505")
    return "This action could not be saved. Check the input and refresh before trying again.";
  return error instanceof Error
    ? error.message
    : "The service is unavailable. Check the local stack and try again.";
}
export interface CsvSettings {
  sku: string;
  price: string;
  description: string;
  delimiter: string;
  decimal: string;
  thousands: string;
  currency: string;
  unit: string;
  pack: string;
  priceBasis: string;
  taxBasis: string;
  symbol: string;
}
export function defaultSettings(): CsvSettings {
  return {
    sku: "SKU",
    price: "Price",
    description: "Description",
    delimiter: ",",
    decimal: ".",
    thousands: "",
    currency: "",
    unit: "",
    pack: "1",
    priceBasis: "unit",
    taxBasis: "net",
    symbol: "",
  };
}
export function csvOptions(s: CsvSettings) {
  if (
    !s.sku.trim() ||
    !s.price.trim() ||
    new Set([s.sku, s.price, ...(s.description ? [s.description] : [])])
      .size !== (s.description ? 3 : 2)
  )
    throw new Error(
      "Use distinct, exact CSV column headers for SKU, cost and description.",
    );
  if (
    !/^[A-Z]{3}$/.test(s.currency) ||
    !s.unit.trim() ||
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s.pack) ||
    /^0(?:\.0+)?$/.test(s.pack)
  )
    throw new Error(
      "Set a three-letter currency, unit and positive pack quantity for each file.",
    );
  if (
    s.thousands === s.decimal ||
    ![".", ","].includes(s.decimal) ||
    !["", ".", ",", " "].includes(s.thousands) ||
    ![",", ";", "\t", "|"].includes(s.delimiter)
  )
    throw new Error(
      "Check delimiter and number conventions; decimal and thousands separators must differ.",
    );
  if (
    !["unit", "pack"].includes(s.priceBasis) ||
    !["net", "gross"].includes(s.taxBasis)
  )
    throw new Error("Choose price and tax basis.");
  return {
    encoding: "utf-8-sig",
    delimiter: s.delimiter,
    decimal_separator: s.decimal,
    thousands_separator: s.thousands || null,
    columns: {
      supplier_sku: s.sku,
      cost_price: s.price,
      ...(s.description ? { description: s.description } : {}),
    },
    currency: s.currency,
    unit: s.unit,
    pack_quantity: s.pack,
    price_basis: s.priceBasis,
    tax_basis: s.taxBasis,
    currency_symbol: s.symbol || null,
  };
}
export async function api(
  client: Client,
  path: string,
  input?: unknown,
): Promise<Response> {
  const { data } = await client.auth.getSession();
  if (!data.session) throw new Error("Your session expired. Sign in again.");
  const response = await fetch(path, {
    method: input ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      ...(input ? { "Content-Type": "application/json" } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "Request failed. Try again.");
  }
  return response;
}
export async function uploadCsv(
  client: Client,
  tenantId: string,
  supplierId: string | null,
  file: File,
  progress: (state: string) => void,
): Promise<string> {
  if (!/\.csv$/i.test(file.name) || file.size < 1 || file.size > 10485760)
    throw new Error("Choose a UTF-8 CSV file between 1 byte and 10 MiB.");
  progress("Registering upload…");
  const intent = await (
    await api(client, "/api/uploads", {
      action: "create",
      tenantId,
      supplierId,
      filename: file.name,
      byteCount: file.size,
    })
  ).json();
  progress("Uploading private file…");
  const { error } = await client.storage
    .from("catalogue-uploads")
    .uploadToSignedUrl(intent.path, intent.token, file, {
      contentType: "text/csv",
    });
  if (error)
    throw new Error(
      "Upload failed. Check your connection and retry this file.",
    );
  progress("Verifying file…");
  await api(client, "/api/uploads", {
    action: "finalize",
    tenantId,
    fileId: intent.fileId,
  });
  progress("Ready");
  return intent.fileId as string;
}
