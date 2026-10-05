import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { localConfigFromEnv } from "../server/supabase-upload-gateway.ts";
import { BUCKET, UploadError } from "../server/uploads.ts";
import { inspectPdf, PDF_MIME } from "../server/pdf.ts";

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  try {
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
    const config = localConfigFromEnv();
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
        "id,tenant_id,status,bucket_id,object_name,verified_mime,byte_count,sha256",
      )
      .eq("tenant_id", value.tenantId)
      .eq("id", value.fileId)
      .maybeSingle();
    const file = result.data;
    if (result.error || !file)
      throw new UploadError(403, "PDF unavailable in this workspace.");
    if (
      file.status !== "ready" ||
      file.verified_mime !== PDF_MIME ||
      file.bucket_id !== BUCKET ||
      file.object_name !== `${value.tenantId}/${value.fileId}/original` ||
      file.byte_count > 10485760
    )
      throw new UploadError(409, "Upload and verify a digital PDF first.");
    const downloaded = await client.storage
      .from(BUCKET)
      .download(file.object_name);
    if (downloaded.error || !downloaded.data)
      throw new UploadError(503, "PDF download unavailable. Retry.");
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (
      bytes.length !== file.byte_count ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new UploadError(
        409,
        "PDF integrity check failed. Upload a fresh copy.",
      );
    const preview = await inspectPdf(bytes);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        ...preview,
        ocrModel: process.env.STOCKSHIFT_OCR_MODEL ?? "PaddleOCR-VL-1.6",
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
