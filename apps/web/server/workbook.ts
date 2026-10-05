import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UploadError } from "./uploads.ts";

export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export interface WorkbookPreview {
  worksheets: { name: string; state: string }[];
  headers?: string[];
  samples?: string[][];
}
export async function inspectWorkbook(
  bytes: Uint8Array,
  worksheet?: string,
  headerRow = 1,
): Promise<WorkbookPreview> {
  if (bytes.length < 1 || bytes.length > 10485760)
    throw new UploadError(422, "Workbook must be between 1 byte and 10 MiB.");
  const python = fileURLToPath(
    new URL(
      `../../../services/worker/.venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`,
      import.meta.url,
    ),
  );
  // No shell, request-supplied executable/path, inherited credentials, or network access.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(SYSTEMROOT|WINDIR|PATH|TEMP|TMP)$/i.test(key),
    ),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      ["-I", "-m", "stockshift_worker.entrypoints.workbook"],
      { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    let output = "",
      settled = false;
    const finish = (error?: Error, value?: WorkbookPreview) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new UploadError(
          503,
          "Workbook inspection timed out. Split the workbook and retry.",
        ),
      );
    }, 30000);
    child.on("error", () =>
      finish(
        new UploadError(
          503,
          "Workbook inspection unavailable. Ask your administrator to start the local worker environment.",
        ),
      ),
    );
    child.stdin.on("error", () =>
      finish(new UploadError(503, "Workbook inspection unavailable.")),
    );
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 512000) {
        child.kill();
        finish(
          new UploadError(422, "Workbook preview exceeds the supported size."),
        );
      }
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new UploadError(503, "Workbook inspection unavailable."));
        return;
      }
      try {
        const result = JSON.parse(output);
        if (result.error) finish(new UploadError(422, result.error));
        else finish(undefined, result.value);
      } catch {
        finish(new UploadError(503, "Workbook inspection unavailable."));
      }
    });
    child.stdin.end(
      JSON.stringify({
        data: Buffer.from(bytes).toString("base64"),
        worksheet,
        headerRow,
      }),
    );
  });
}
