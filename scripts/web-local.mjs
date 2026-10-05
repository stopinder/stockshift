// Keys are obtained only from the running local stack. Never load .env or hosted variables.
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|VITE_)/i.test(
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
if (
  state.API_URL !== "http://127.0.0.1:54321" ||
  !state.ANON_KEY ||
  !state.SERVICE_ROLE_KEY
)
  throw new Error("Start local Supabase first");
Object.assign(env, {
  STOCKSHIFT_LOCAL_SUPABASE_URL: state.API_URL,
  STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: state.ANON_KEY,
  STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY: state.SERVICE_ROLE_KEY,
  VITE_STOCKSHIFT_LOCAL_SUPABASE_URL: state.API_URL,
  VITE_STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: state.ANON_KEY,
});
const child = spawn(
  process.execPath,
  ["../../node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { cwd: `${root}/apps/web`, env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
