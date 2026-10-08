import { createClient } from "@supabase/supabase-js";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  serverConfigFromEnv,
  SupabaseUploadGateway,
} from "../server/supabase-upload-gateway.ts";
import {
  BUCKET,
  UploadError,
  requireSupportedUpload,
  PDF_MIME,
} from "../server/uploads.ts";

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
    requireSupportedUpload("inspection.pdf");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      throw new UploadError(405, "Use POST.");
    }
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer "))
      throw new UploadError(401, "Sign in to inspect a PDF.");
    const value = req.body as {
      tenantId?: string;
      fileId?: string;
    };
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !["tenantId", "fileId"].includes(k)) ||
      !uuid.test(value.tenantId ?? "") ||
      !uuid.test(value.fileId ?? "")
    )
      throw new UploadError(400, "Choose a valid PDF source.");
    const config = serverConfigFromEnv();
    await new SupabaseUploadGateway(config).verifyPdfCapabilities();
    const client = createClient(config.url, config.publishableKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authorization } },
    });
    const user = await client.auth.getUser(authorization.slice(7));
    if (user.error || !user.data.user || user.data.user.is_anonymous)
      throw new UploadError(401, "Sign in again.");
    const result = await client
      .from("source_files")
      .select(
        "id,tenant_id,original_filename,status,bucket_id,object_name,verified_mime,byte_count,sha256",
      )
      .eq("tenant_id", value.tenantId)
      .eq("id", value.fileId)
      .maybeSingle();
    const file = result.data;
    if (result.error || !file)
      throw new UploadError(403, "PDF unavailable in this workspace.");
    if (
      !/\.pdf$/i.test(file.original_filename) ||
      (file.status === "ready" &&
        (file.verified_mime !== PDF_MIME ||
          !Number.isSafeInteger(file.byte_count) ||
          file.byte_count < 1 ||
          file.byte_count > 10485760 ||
          !/^[0-9a-f]{64}$/.test(file.sha256 ?? ""))) ||
      file.bucket_id !== BUCKET ||
      file.object_name !== `${value.tenantId}/${value.fileId}/original`
    )
      throw new UploadError(409, "Choose a registered PDF source.");
    const inspection = await client
      .from("pdf_inspections")
      .select("id,status,page_count,diagnostics,failure_reason")
      .eq("tenant_id", value.tenantId)
      .eq("source_file_id", value.fileId)
      .eq("inspector_version", "cpu-inspection-v1")
      .maybeSingle();
    if (inspection.error)
      throw new UploadError(503, "Inspection status unavailable. Retry.");
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        fileId: file.id,
        byteVerification: file.status === "ready" ? "verified" : file.status,
        inspection: inspection.data
          ? {
              id: inspection.data.id,
              status: inspection.data.status,
              pageCount: inspection.data.page_count,
              diagnostics: inspection.data.diagnostics,
              failure: inspection.data.failure_reason,
            }
          : {
              id: null,
              status: "not_queued",
              pageCount: null,
              diagnostics: null,
              failure: null,
            },
        comparisonEligibility: "requires_confirmed_extraction",
      }),
    );
  } catch (error) {
    res.statusCode = error instanceof UploadError ? error.status : 503;
    res.end(
      JSON.stringify({
        error:
          error instanceof UploadError
            ? error.message
            : "PDF inspection unavailable. Retry.",
      }),
    );
  }
}
