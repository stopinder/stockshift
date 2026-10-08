import { createClient } from "@supabase/supabase-js";
import { browserConfigFromEnv } from "./supabase-config";
import { hostedPdfCapabilities } from "./pdf-capabilities";
export { validateBrowserConfig } from "./supabase-config";

export function browserClient() {
  // Reference only the allowlisted public values, never the whole Vite env object.
  const config = browserConfigFromEnv({
    VITE_STOCKSHIFT_SUPABASE_MODE: import.meta.env
      .VITE_STOCKSHIFT_SUPABASE_MODE,
    VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: import.meta.env
      .VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED,
    VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: import.meta.env
      .VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED,
    VITE_STOCKSHIFT_CSV_ONLY: import.meta.env.VITE_STOCKSHIFT_CSV_ONLY,
    VITE_STOCKSHIFT_SUPABASE_URL: import.meta.env.VITE_STOCKSHIFT_SUPABASE_URL,
    VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: import.meta.env
      .VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY,
    VITE_STOCKSHIFT_LOCAL_SUPABASE_URL: import.meta.env
      .VITE_STOCKSHIFT_LOCAL_SUPABASE_URL,
    VITE_STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: import.meta.env
      .VITE_STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY,
  });
  return createClient(config.url, config.key);
}
const hostedBrowser =
  import.meta.env?.VITE_STOCKSHIFT_SUPABASE_MODE === "hosted";
const hostedPdf = hostedPdfCapabilities(
  {
    VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED: import.meta.env
      ?.VITE_STOCKSHIFT_HOSTED_PDF_INSPECTION_ENABLED,
    VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED: import.meta.env
      ?.VITE_STOCKSHIFT_HOSTED_PDF_EXTRACTION_ENABLED,
    VITE_STOCKSHIFT_CSV_ONLY: import.meta.env?.VITE_STOCKSHIFT_CSV_ONLY,
  },
  "VITE_",
);
export const csvOnly =
  import.meta.env?.VITE_STOCKSHIFT_CSV_ONLY === "1" ||
  (hostedBrowser && !hostedPdf.inspection);
export const digitalPdfEnabled = !hostedBrowser || hostedPdf.extraction;
export const uploadAccept = csvOnly
  ? ".csv,text/csv"
  : hostedBrowser
    ? ".csv,text/csv,.pdf,application/pdf"
    : ".pdf,application/pdf,.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const uploadFormatLabel = csvOnly
  ? "CSV preview"
  : hostedBrowser
    ? "CSV or digital PDF"
    : "CSV, XLSX or PDF";
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
  locator: {
    row: number | null;
    column: string | null;
    sheet?: string | null;
    page?: number | null;
    table?: string | null;
  };
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
  pdfRevisionId?: string | undefined;
  worksheet?: string;
  headerRow?: number;
  currencyColumn?: string;
  packColumn?: string;
  unitColumn?: string;
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
export function csvOptions(s: CsvSettings, mappedFields: string[] = []) {
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
    (!mappedFields.includes("currency") && !/^[A-Z]{3}$/.test(s.currency)) ||
    (!mappedFields.includes("unit") && !s.unit.trim()) ||
    (!mappedFields.includes("pack_quantity") &&
      (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(s.pack) ||
        /^0(?:\.0+)?$/.test(s.pack)))
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
    currency: mappedFields.includes("currency") ? null : s.currency,
    unit: mappedFields.includes("unit") ? null : s.unit,
    pack_quantity: mappedFields.includes("pack_quantity") ? null : s.pack,
    price_basis: s.priceBasis,
    tax_basis: s.taxBasis,
    currency_symbol: s.symbol || null,
  };
}
export function importOptions(s: CsvSettings, filename: string) {
  if (/\.pdf$/i.test(filename) && !digitalPdfEnabled)
    throw new Error("Digital PDF comparison is disabled.");
  if (/\.pdf$/i.test(filename)) {
    if (
      !s.pdfRevisionId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        s.pdfRevisionId,
      )
    )
      throw new Error(
        "Confirm PDF mapping and corrections before starting the comparison.",
      );
    return { format: "pdf", revision_id: s.pdfRevisionId };
  }
  if (!/\.xlsx$/i.test(filename)) return csvOptions(s);
  const options = csvOptions(s, [
    ...(s.currencyColumn ? ["currency"] : []),
    ...(s.packColumn ? ["pack_quantity"] : []),
    ...(s.unitColumn ? ["unit"] : []),
  ]);
  if (
    !s.worksheet ||
    !Number.isInteger(s.headerRow) ||
    s.headerRow! < 1 ||
    s.headerRow! > 200
  )
    throw new Error(
      "Choose a worksheet and header row from 1 to 200 for each workbook.",
    );
  const columns = {
    ...options.columns,
    ...(s.currencyColumn ? { currency: s.currencyColumn } : {}),
    ...(s.packColumn ? { pack_quantity: s.packColumn } : {}),
    ...(s.unitColumn ? { unit: s.unitColumn } : {}),
  };
  if (new Set(Object.values(columns)).size !== Object.keys(columns).length)
    throw new Error("Map each field to a different worksheet column.");
  return {
    ...options,
    columns,
    format: "xlsx",
    worksheet: s.worksheet,
    header_row: s.headerRow,
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
  if (
    !/\.(csv|xlsx|pdf)$/i.test(file.name) ||
    file.size < 1 ||
    file.size > 10485760
  )
    throw new Error(
      "Choose a CSV, XLSX or PDF file between 1 byte and 10 MiB.",
    );
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
      contentType: /\.pdf$/i.test(file.name)
        ? "application/pdf"
        : /\.xlsx$/i.test(file.name)
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : "text/csv",
    });
  if (error)
    throw new Error(
      "Upload failed. Check your connection and retry this file.",
    );
  progress("Verifying file…");
  try {
    await api(client, "/api/uploads", {
      action: "finalize",
      tenantId,
      fileId: intent.fileId,
    });
  } catch (failure) {
    // Preserve the ready upload when enqueue or its response was interrupted.
    // The attached PDF settings offer an explicit idempotent enqueue retry.
    if (!/\.pdf$/i.test(file.name)) throw failure;
    const source = await client
      .from("source_files")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("id", intent.fileId)
      .maybeSingle();
    if (source.error || source.data?.status !== "ready") throw failure;
    progress("Bytes verified · check inspection status");
    return intent.fileId as string;
  }
  progress(
    /\.pdf$/i.test(file.name) ? "Bytes verified · inspection pending" : "Ready",
  );
  return intent.fileId as string;
}
