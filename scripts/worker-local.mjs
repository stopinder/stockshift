import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_)/i.test(
        key,
      ),
  ),
);
const state = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/supabase-local.mjs", "status", "--output", "json"],
    { cwd: root, env, encoding: "utf8" },
  ),
);
if (state.API_URL !== "http://127.0.0.1:54321" || !state.SERVICE_ROLE_KEY)
  throw new Error("Start local Supabase first");
const python = resolve(
  root,
  "services/worker/.venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const child = spawn(
  python,
  ["-m", "stockshift_worker.entrypoints.cli", "--poll"],
  {
    cwd: root,
    env: {
      ...env,
      STOCKSHIFT_SUPABASE_MODE: "local",
      STOCKSHIFT_LOCAL_SUPABASE_URL: state.API_URL,
      STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: state.SERVICE_ROLE_KEY,
    },
    stdio: "inherit",
  },
);
child.on("error", () => {
  console.error("Install the local worker environment first.");
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
