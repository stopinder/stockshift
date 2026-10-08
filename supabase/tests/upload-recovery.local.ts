// Native loopback Auth/Storage/Postgres acceptance; never accepts hosted credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { before, after, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { SupabaseUploadGateway } from "../../apps/web/server/supabase-upload-gateway";
import {
  createUploadIntent,
  finalizeUpload,
  UploadError,
  type UploadGateway,
} from "../../apps/web/server/uploads";

const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_)/i.test(
        key,
      ),
  ),
);
const status = JSON.parse(
  execFileSync(
    process.execPath,
    ["scripts/supabase-local.mjs", "status", "--output", "json"],
    { env, encoding: "utf8" },
  ),
);
const url = "http://127.0.0.1:54321";
assert.equal(status.API_URL, url);
assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY);
const config = {
  url,
  publishableKey: status.ANON_KEY,
  secretKey: status.SERVICE_ROLE_KEY,
};
const admin = createClient(url, config.secretKey, {
  auth: { persistSession: false },
});
const db = new Client({
  host: "127.0.0.1",
  port: 54322,
  database: "postgres",
  user: "postgres",
  password: "postgres",
  ssl: false,
});
const gateway = new SupabaseUploadGateway(config);
const A = randomUUID(),
  B = randomUUID();
const users: Record<
  string,
  { id: string; token: string; client: ReturnType<typeof createClient> }
> = {};
const bytes = Buffer.from("sku,price\n00042,4.20\n");
const verified = {
  bytes: bytes.length,
  mime: "text/csv",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
before(async () => {
  await db.connect();
  for (const role of ["editor", "owner", "viewer", "other"]) {
    const email = `${randomUUID()}@stockshift.local`,
      password = randomUUID();
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    assert.ifError(created.error);
    const client = createClient(url, config.publishableKey, {
      auth: { persistSession: false },
    });
    const login = await client.auth.signInWithPassword({ email, password });
    assert.ifError(login.error);
    users[role] = {
      id: created.data.user!.id,
      token: login.data.session!.access_token,
      client,
    };
  }
  await db.query("insert into public.tenants(id,name) values ($1,$2),($3,$4)", [
    A,
    "Recovery A",
    B,
    "Recovery B",
  ]);
  for (const role of Object.keys(users))
    await db.query(
      "insert into public.tenant_memberships(tenant_id,user_id,role) values ($1,$2,$3)",
      [
        role === "other" ? B : A,
        users[role]!.id,
        role === "other" ? "owner" : role,
      ],
    );
});
after(async () => {
  await db.end();
});
async function uploaded() {
  const file = await createUploadIntent(gateway, users.editor!.token, {
    tenantId: A,
    filename: "recovery.csv",
    byteCount: bytes.length,
  });
  assert.ifError(
    (
      await users
        .editor!.client.storage.from("catalogue-uploads")
        .uploadToSignedUrl(file.path, file.token, bytes, {
          contentType: "text/csv",
        })
    ).error,
  );
  return file.fileId;
}
const finish = (id: string, g: UploadGateway = gateway) =>
  finalizeUpload(g, users.editor!.token, { tenantId: A, fileId: id });
const begin = (id: string) =>
  gateway.transition(A, id, users.editor!.id, "begin");
async function expire(id: string) {
  await db.query(
    "update private.upload_verification_leases set expires_at=clock_timestamp()-interval '1 second' where source_file_id=$1",
    [id],
  );
}
async function source(id: string) {
  return (await db.query("select * from public.source_files where id=$1", [id]))
    .rows[0];
}
function override(methods: Partial<UploadGateway>): UploadGateway {
  return new Proxy(gateway, {
    get(target, property) {
      const custom = Reflect.get(methods, property);
      if (custom) return custom;
      const original = Reflect.get(target, property);
      return typeof original === "function" ? original.bind(target) : original;
    },
  });
}
function heldDownload() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const g = override({
    async download(path) {
      enter();
      await released;
      return gateway.download(path);
    },
  });
  return { g, entered, release };
}

test("crash after claim recovers after expiry with a fresh hash; ready replay is idempotent", async () => {
  const id = await uploaded(),
    first = await begin(id);
  assert.equal(first.status, "verifying");
  assert.ok(first.verification_lease);
  const lease = (
    await db.query(
      "select * from private.upload_verification_leases where source_file_id=$1",
      [id],
    )
  ).rows[0];
  assert.ok(
    Math.abs(Date.parse(lease.expires_at) - Date.now() - 120000) < 10000,
  );
  await assert.rejects(finish(id), { status: 409 });
  await expire(id);
  let downloads = 0;
  const ready = await finish(
    id,
    override({
      async download(path) {
        downloads++;
        return gateway.download(path);
      },
    }),
  );
  assert.equal(ready.status, "ready");
  assert.equal(ready.sha256, verified.sha256);
  assert.equal(downloads, 1);
  assert.deepEqual(await finish(id), ready);
  assert.equal(
    (
      await db.query(
        "select attempt_count from private.upload_verification_leases where source_file_id=$1",
        [id],
      )
    ).rows[0].attempt_count,
    2,
  );
});
test("legacy verifying source without a lease recovers without resetting data", async () => {
  const id = await uploaded();
  await db.query(
    "update public.source_files set status='verifying' where id=$1",
    [id],
  );
  assert.equal((await finish(id)).sha256, verified.sha256);
});
test("concurrent finalizers have one live claim; second cannot overwrite first", async () => {
  const id = await uploaded(),
    held = heldDownload(),
    first = finish(id, held.g);
  try {
    await held.entered;
    await assert.rejects(finish(id), { status: 409 });
  } finally {
    held.release();
  }
  assert.equal((await first).sha256, verified.sha256);
  assert.equal(
    (
      await db.query(
        "select attempt_count from private.upload_verification_leases where source_file_id=$1",
        [id],
      )
    ).rows[0].attempt_count,
    1,
  );
});
test("expired completion is rejected, including fail and retry", async () => {
  const id = await uploaded(),
    claimed = await begin(id);
  await expire(id);
  for (const action of ["finish", "fail", "retry"] as const)
    await assert.rejects(
      gateway.transition(
        A,
        id,
        users.editor!.id,
        action,
        action === "finish" ? verified : undefined,
        claimed.verification_lease,
      ),
      { status: 409 },
    );
  assert.equal((await source(id)).status, "verifying");
});
test("replacement lease fences stale completion, failure and release; same-token finish can replay", async () => {
  const id = await uploaded(),
    first = await begin(id);
  await expire(id);
  const second = await begin(id);
  assert.notEqual(second.verification_lease, first.verification_lease);
  for (const action of ["finish", "fail", "retry"] as const)
    await assert.rejects(
      gateway.transition(
        A,
        id,
        users.editor!.id,
        action,
        action === "finish" ? verified : undefined,
        first.verification_lease,
      ),
      { status: 403 },
    );
  const ready = await gateway.transition(
    A,
    id,
    users.editor!.id,
    "finish",
    verified,
    second.verification_lease,
  );
  assert.deepEqual(
    await gateway.transition(
      A,
      id,
      users.editor!.id,
      "finish",
      verified,
      second.verification_lease,
    ),
    ready,
  );
  await assert.rejects(
    gateway.transition(
      A,
      id,
      users.editor!.id,
      "finish",
      verified,
      first.verification_lease,
    ),
    { status: 403 },
  );
});
test("slow superseded finalizer cannot invalidate a recovered ready source", async () => {
  const id = await uploaded(),
    held = heldDownload();
  const stale = assert.rejects(finish(id, held.g), { status: 403 });
  try {
    await held.entered;
    await expire(id);
    assert.equal((await finish(id)).status, "ready");
  } finally {
    held.release();
  }
  await stale;
  assert.equal((await source(id)).sha256, verified.sha256);
  assert.equal((await source(id)).status, "ready");
});
test("transient download failure releases its lease and retry verifies actual bytes", async () => {
  const id = await uploaded();
  await assert.rejects(
    finish(
      id,
      override({
        async download() {
          throw new UploadError(503, "Interrupted download");
        },
      }),
    ),
    { status: 503 },
  );
  assert.equal((await source(id)).status, "verifying");
  assert.equal((await finish(id)).sha256, verified.sha256);
});
test("lost finish response preserves ready state and supports finalization retry", async () => {
  const id = await uploaded();
  const g = override({
    async transition(...args) {
      const result = await gateway.transition(...args);
      if (args[3] === "finish") throw new UploadError(503, "Lost response");
      return result;
    },
  });
  await assert.rejects(finish(id, g), { status: 503 });
  assert.equal((await source(id)).status, "ready");
  assert.equal((await finish(id)).sha256, verified.sha256);
});
test("five interrupted attempts exhaust recovery without publishing ready", async () => {
  const id = await uploaded();
  for (let i = 0; i < 5; i++) {
    await begin(id);
    await expire(id);
  }
  await assert.rejects(finish(id), {
    status: 409,
    message: "Verification retry limit reached. Create a new upload.",
  });
  assert.equal((await source(id)).status, "failed");
  assert.equal((await source(id)).sha256, null);
});
test("recovery excludes viewers, other tenants and same-tenant non-creators", async () => {
  const id = await uploaded();
  await begin(id);
  await expire(id);
  for (const role of ["viewer", "other", "owner"]) {
    await assert.rejects(
      finalizeUpload(gateway, users[role]!.token, { tenantId: A, fileId: id }),
      { status: 403 },
    );
    await assert.rejects(gateway.transition(A, id, users[role]!.id, "begin"), {
      status: 403,
    });
  }
  await assert.rejects(gateway.transition(B, id, users.editor!.id, "begin"), {
    status: 403,
  });
  assert.equal((await source(id)).status, "verifying");
  assert.equal((await finish(id)).status, "ready");
});
test("membership is rechecked at finish even after authorized download starts", async () => {
  const id = await uploaded(),
    held = heldDownload();
  const denied = assert.rejects(finish(id, held.g), { status: 403 });
  try {
    await held.entered;
    await db.query(
      "update public.tenant_memberships set role='viewer' where tenant_id=$1 and user_id=$2",
      [A, users.editor!.id],
    );
    held.release();
    await denied;
    assert.equal((await source(id)).status, "verifying");
  } finally {
    held.release();
    await db.query(
      "update public.tenant_memberships set role='editor' where tenant_id=$1 and user_id=$2",
      [A, users.editor!.id],
    );
  }
  await expire(id);
  assert.equal((await finish(id)).status, "ready");
});
test("completion rechecks Storage ownership/size, verified size/hash and missing tokens", async () => {
  const id = await uploaded(),
    claim = await begin(id);
  await assert.rejects(
    gateway.transition(A, id, users.editor!.id, "finish", verified),
    { status: 403 },
  );
  for (const invalid of [
    { ...verified, bytes: bytes.length - 1 },
    { ...verified, sha256: "invalid" },
  ])
    await assert.rejects(
      gateway.transition(
        A,
        id,
        users.editor!.id,
        "finish",
        invalid,
        claim.verification_lease,
      ),
      { status: 409 },
    );
  // Negative SQL fixtures seed an inconsistent claim without changing real blobs.
  for (const [owner, size] of [
    [users.owner!.id, bytes.length],
    [users.editor!.id, bytes.length - 1],
  ]) {
    const file = await createUploadIntent(gateway, users.editor!.token, {
      tenantId: A,
      filename: "invalid-metadata.csv",
      byteCount: bytes.length,
    });
    const lease = randomUUID();
    await db.query("begin");
    try {
      await db.query(
        "insert into storage.objects(bucket_id,name,owner_id,metadata) values ('catalogue-uploads',$1,$2,$3)",
        [file.path, owner, { size }],
      );
      await db.query(
        "update public.source_files set status='verifying' where id=$1",
        [file.fileId],
      );
      await db.query(
        "insert into private.upload_verification_leases values ($1,$2,clock_timestamp()+interval '120 seconds',1)",
        [file.fileId, lease],
      );
      await assert.rejects(
        db.query(
          "select public.transition_catalogue_upload($1,$2,$3,'finish',$4,$5,$6,$7::uuid)",
          [
            A,
            file.fileId,
            users.editor!.id,
            verified.bytes,
            verified.mime,
            verified.sha256,
            lease,
          ],
        ),
        { code: "23514" },
      );
    } finally {
      await db.query("rollback");
    }
  }
  assert.equal(
    (
      await gateway.transition(
        A,
        id,
        users.editor!.id,
        "finish",
        verified,
        claim.verification_lease,
      )
    ).status,
    "ready",
  );
});
test("lease internals and transition RPC cannot be called by browser roles", async () => {
  const id = await uploaded();
  assert.ok(
    (
      await users.editor!.client.rpc("transition_catalogue_upload", {
        p_tenant: A,
        p_file: id,
        p_actor: users.editor!.id,
        p_action: "begin",
        p_bytes: null,
        p_mime: null,
        p_sha: null,
        p_lease: null,
      })
    ).error,
  );
  for (const role of ["authenticated", "service_role"]) {
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      await assert.rejects(
        db.query("select * from private.upload_verification_leases"),
        { code: "42501" },
      );
    } finally {
      await db.query("rollback");
    }
  }
});
