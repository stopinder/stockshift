import { createHash } from "node:crypto";
import { inspectWorkbook, XLSX_MIME } from "./workbook.ts";
import { hostedPdfCapabilities } from "../src/pdf-capabilities.ts";
export const PDF_MIME = "application/pdf";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const BUCKET = "catalogue-uploads";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function csvPreviewOnly(env = process.env): boolean {
  return (
    ((env.STOCKSHIFT_SUPABASE_MODE === "hosted" || env.VERCEL === "1") &&
      !hostedPdfCapabilities(env).inspection) ||
    env.STOCKSHIFT_CSV_ONLY === "1"
  );
}
export function requireSupportedUpload(filename: string): void {
  const hosted =
    process.env.STOCKSHIFT_SUPABASE_MODE === "hosted" ||
    process.env.VERCEL === "1";
  if (hosted && /\.xlsx$/i.test(filename))
    throw new UploadError(422, "Hosted XLSX uploads are unavailable.");
  if (csvPreviewOnly() && !/\.csv$/i.test(filename))
    throw new UploadError(
      422,
      "This preview supports CSV only. XLSX, PDF and OCR are unavailable.",
    );
  if (
    /\.pdf$/i.test(filename) &&
    !(hosted
      ? hostedPdfCapabilities(process.env).inspection
      : process.env.STOCKSHIFT_PDF_INSPECTION_ENABLED === "1")
  )
    throw new UploadError(422, "PDF inspection uploads are disabled.");
}
export type Role = "owner" | "editor" | "viewer";
export interface SourceFile {
  id: string;
  tenant_id: string;
  created_by: string;
  original_filename: string;
  bucket_id: string;
  object_name: string;
  expected_byte_count: number;
  status: "pending" | "verifying" | "ready" | "failed";
  byte_count: number | null;
  verified_mime: string | null;
  sha256: string | null;
  verification_lease?: string;
  verification_exhausted?: boolean;
}
export interface Intent {
  tenantId: string;
  filename: string;
  byteCount: number;
  supplierId: string | null;
  importProfileId: string | null;
}
async function verifyHostedPdf(gateway: UploadGateway, filename: string) {
  if (
    /\.pdf$/i.test(filename) &&
    (process.env.STOCKSHIFT_SUPABASE_MODE === "hosted" ||
      process.env.VERCEL === "1")
  ) {
    if (!gateway.verifyPdfCapabilities)
      throw new UploadError(503, "CPU PDF worker capabilities unavailable");
    await gateway.verifyPdfCapabilities();
  }
}
export interface UploadGateway {
  verifyPdfCapabilities?(): Promise<void>;
  sourceFile(
    tenantId: string,
    fileId: string,
    token: string,
  ): Promise<SourceFile>;
  enqueueInspection(
    tenantId: string,
    fileId: string,
    token: string,
  ): Promise<{ id: string; status: string }>;
  authenticate(token: string): Promise<string>;
  membership(tenantId: string, userId: string): Promise<Role | null>;
  createIntent(input: Intent, token: string): Promise<SourceFile>;
  signUpload(
    path: string,
    token: string,
  ): Promise<{ signedUrl: string; token: string }>;
  transition(
    tenantId: string,
    fileId: string,
    actor: string,
    action: "begin" | "finish" | "fail" | "retry",
    verified?: { bytes: number; mime: string; sha256: string },
    lease?: string,
  ): Promise<SourceFile>;
  download(path: string): Promise<Blob>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new UploadError(400, "Invalid resource ID");
  return value;
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new UploadError(400, "Invalid request");
  return input as Record<string, unknown>;
}
export function parseIntent(input: unknown): Intent {
  const value = object(input);
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "tenantId",
          "filename",
          "byteCount",
          "supplierId",
          "importProfileId",
        ].includes(key),
    )
  ) {
    throw new UploadError(400, "Unknown upload property");
  }
  const filename = value.filename;
  if (
    typeof filename !== "string" ||
    filename.length > 255 ||
    !/\.(csv|xlsx|pdf)$/i.test(filename) ||
    /[/\\\x00-\x1f\x7f]/.test(filename)
  )
    throw new UploadError(400, "Use a plain CSV, XLSX or PDF filename");
  requireSupportedUpload(filename);
  const bytes = value.byteCount;
  if (
    typeof bytes !== "number" ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAX_UPLOAD_BYTES
  ) {
    throw new UploadError(400, "File size must be 1 byte to 10 MiB");
  }
  return {
    tenantId: id(value.tenantId),
    filename,
    byteCount: bytes,
    supplierId: value.supplierId == null ? null : id(value.supplierId),
    importProfileId:
      value.importProfileId == null ? null : id(value.importProfileId),
  };
}

async function authorize(
  gateway: UploadGateway,
  token: string,
  tenant: string,
): Promise<string> {
  if (!token || token.length > 8192)
    throw new UploadError(401, "Authentication required");
  const actor = id(await gateway.authenticate(token));
  const role = await gateway.membership(tenant, actor);
  if (role !== "owner" && role !== "editor")
    throw new UploadError(403, "Editor membership required");
  return actor;
}
function registered(
  file: SourceFile,
  tenant: string,
  actor: string,
  fileId?: string,
): void {
  if (
    file.tenant_id !== tenant ||
    file.created_by !== actor ||
    (fileId && file.id !== fileId) ||
    file.bucket_id !== BUCKET ||
    file.object_name !== `${tenant}/${id(file.id)}/original` ||
    !Number.isSafeInteger(file.expected_byte_count) ||
    file.expected_byte_count < 1 ||
    file.expected_byte_count > MAX_UPLOAD_BYTES
  )
    throw new UploadError(403, "Invalid registered upload");
}
function publicFile(file: SourceFile) {
  return {
    id: file.id,
    status: file.status,
    filename: file.original_filename,
    byteCount: file.byte_count,
    mime: file.verified_mime,
    sha256: file.sha256,
  };
}

export async function createUploadIntent(
  gateway: UploadGateway,
  token: string,
  input: unknown,
) {
  const request = parseIntent(input);
  const actor = await authorize(gateway, token, request.tenantId);
  await verifyHostedPdf(gateway, request.filename);
  const file = await gateway.createIntent(request, token);
  registered(file, request.tenantId, actor);
  if (file.status !== "pending")
    throw new UploadError(409, "Upload is not pending");
  const signed = await gateway.signUpload(file.object_name, token);
  return { fileId: file.id, bucket: BUCKET, path: file.object_name, ...signed };
}

export function verifyCsv(bytes: Uint8Array): { mime: string; sha256: string } {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new UploadError(422, "Invalid uploaded byte count");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UploadError(
      422,
      "Only UTF-8 CSV uploads are currently supported",
    );
  }
  if (
    !text.trim() ||
    /^[\s\ufeff]*%PDF-/.test(text) ||
    text.startsWith("PK\x03\x04") ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)
  ) {
    throw new UploadError(422, "Upload is not supported CSV text");
  }
  return {
    mime: "text/csv",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function finalizeUpload(
  gateway: UploadGateway,
  token: string,
  input: unknown,
) {
  const value = object(input);
  if (Object.keys(value).some((key) => !["tenantId", "fileId"].includes(key)))
    throw new UploadError(400, "Unknown finalization property");
  const tenant = id(value.tenantId),
    fileId = id(value.fileId);
  const actor = await authorize(gateway, token, tenant);
  const source = await gateway.sourceFile(tenant, fileId, token);
  registered(source, tenant, actor, fileId);
  requireSupportedUpload(source.original_filename);
  await verifyHostedPdf(gateway, source.original_filename);
  async function finalized(file: SourceFile) {
    if (!/\.pdf$/i.test(file.original_filename)) return publicFile(file);
    // Bytes remain ready if enqueue fails. Retrying finalization recovers this gap.
    try {
      const inspection = await gateway.enqueueInspection(tenant, fileId, token);
      return {
        ...publicFile(file),
        byteVerification: "verified",
        inspection,
        comparisonEligibility: "requires_confirmed_extraction",
      };
    } catch {
      throw new UploadError(
        503,
        "PDF bytes verified; inspection enqueue unavailable. Retry finalization.",
      );
    }
  }
  const file = await gateway.transition(tenant, fileId, actor, "begin");
  registered(file, tenant, actor, fileId);
  if (file.status === "ready") {
    requireSupportedUpload(file.original_filename);
    return finalized(file);
  }
  if (file.status !== "verifying")
    throw new UploadError(
      409,
      file.verification_exhausted
        ? "Verification retry limit reached. Create a new upload."
        : "Upload cannot be finalized",
    );
  const lease = file.verification_lease;
  if (!lease || !uuid.test(lease))
    throw new UploadError(
      503,
      "Verification lease unavailable. Retry finalization.",
    );
  let ready: SourceFile;
  try {
    requireSupportedUpload(file.original_filename);
    const blob = await gateway.download(file.object_name);
    if (blob.size !== file.expected_byte_count)
      throw new UploadError(422, "Uploaded size differs from intent");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let verification: { mime: string; sha256: string };
    if (/\.pdf$/i.test(file.original_filename)) {
      if (
        bytes.length < 5 ||
        Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
      )
        throw new UploadError(
          422,
          "Uploaded bytes do not have a PDF signature.",
        );
      verification = {
        mime: PDF_MIME,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } else if (/\.xlsx$/i.test(file.original_filename)) {
      await inspectWorkbook(bytes);
      verification = {
        mime: XLSX_MIME,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } else verification = verifyCsv(bytes);
    ready = await gateway.transition(
      tenant,
      fileId,
      actor,
      "finish",
      {
        bytes: blob.size,
        ...verification,
      },
      lease,
    );
    registered(ready, tenant, actor, fileId);
    if (ready.status !== "ready")
      throw new UploadError(409, "Upload did not finalize");
  } catch (error) {
    // Invalid bytes are terminal; transient failures release only this attempt.
    // A stale attempt cannot fail/release a newer lease or a committed ready source.
    await gateway
      .transition(
        tenant,
        fileId,
        actor,
        error instanceof UploadError && error.status === 422 ? "fail" : "retry",
        undefined,
        lease,
      )
      .catch(() => undefined);
    throw error;
  }
  return finalized(ready);
}
