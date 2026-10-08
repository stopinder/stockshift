// Synthetic local account only. This does not read or use hosted credentials.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
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
    { env, encoding: "utf8" },
  ),
);
if (state.API_URL !== "http://127.0.0.1:54321")
  throw new Error("Local stack required");
const admin = createClient(state.API_URL, state.SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const email = `local-${randomUUID()}@stockshift.local`,
  password = randomUUID(),
  tenant = randomUUID();
const created = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (created.error || !created.data.user)
  throw new Error("Could not create local account");
const db = new Client({
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
});
await db.connect();
try {
  await db.query("begin");
  await db.query("insert into public.tenants(id,name) values($1,$2)", [
    tenant,
    "Local catalogue workspace",
  ]);
  await db.query(
    "insert into public.tenant_memberships(tenant_id,user_id,role) values($1,$2,'owner')",
    [tenant, created.data.user.id],
  );
  await db.query("commit");
} catch (error) {
  await db.query("rollback");
  throw error;
} finally {
  await db.end();
}
console.log(
  `Local sign-in email: ${email}\nLocal sign-in password: ${password}\nWorkspace: Local catalogue workspace`,
);
