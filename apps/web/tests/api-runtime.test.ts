import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { test } from "node:test";
import ts from "typescript";

test("emitted Vercel API modules reference JavaScript files", () => {
  const configFile = fileURLToPath(new URL("../api/tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configFile), undefined, configFile).options;
  for (const path of ["api/uploads.ts", "api/export.ts", "api/pdf.ts", "api/workbook.ts", "server/uploads.ts", "server/supabase-upload-gateway.ts", "server/export.ts"]) {
    const filename = fileURLToPath(new URL(`../${path}`, import.meta.url));
    const emitted = ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: { ...options, noEmit: false } }).outputText;
    assert.doesNotMatch(emitted, /(?:from\s*|import\s*)["'][^"']+\.ts["']/, `${path} must load in the deployed JavaScript package`);
    assert.match(emitted, /["'][^"']+\.js["']/);
  }
});
