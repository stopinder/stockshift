import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserConfigFromEnv,
  validateBrowserConfig,
} from "../src/supabase-config";
import {
  serverConfigFromEnv,
  validateDeploymentConfig,
} from "../server/supabase-upload-gateway";
const hosted = "https://preview-fixture.supabase.co";
const publicKey = "sb_publishable_synthetic";
const privateKey = "sb_secret_synthetic";
const browser = {
  VITE_STOCKSHIFT_SUPABASE_MODE: "hosted",
  VITE_STOCKSHIFT_SUPABASE_URL: hosted,
  VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: publicKey,
};
const server = {
  VERCEL: "1",
  STOCKSHIFT_SUPABASE_MODE: "hosted",
  STOCKSHIFT_SUPABASE_URL: hosted,
  STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: publicKey,
  STOCKSHIFT_SUPABASE_SECRET_KEY: privateKey,
};
test("explicit hosted browser configuration contains only public configuration", () => {
  assert.deepEqual(browserConfigFromEnv(browser, true), {
    url: hosted,
    key: publicKey,
  });
  assert.throws(() => validateBrowserConfig(hosted, publicKey));
});
test("Vercel requires explicit complete hosted configuration before build/runtime", () => {
  assert.throws(() => browserConfigFromEnv({}, true));
  assert.throws(() =>
    browserConfigFromEnv(
      { ...browser, VITE_STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: "" },
      true,
    ),
  );
  assert.throws(() => serverConfigFromEnv({ VERCEL: "1" }));
  assert.throws(() =>
    serverConfigFromEnv({ ...server, STOCKSHIFT_SUPABASE_SECRET_KEY: "" }),
  );
});
test("local launchers retain strict loopback behavior and never fall back to hosted keys", () => {
  assert.deepEqual(
    browserConfigFromEnv({
      VITE_STOCKSHIFT_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
      VITE_STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY: publicKey,
    }),
    { url: "http://127.0.0.1:54321", key: publicKey },
  );
  assert.throws(() =>
    serverConfigFromEnv({
      ...server,
      STOCKSHIFT_SUPABASE_MODE: "local",
      VERCEL: "0",
    }),
  );
  assert.throws(() =>
    browserConfigFromEnv({
      ...browser,
      VITE_STOCKSHIFT_SUPABASE_MODE: "local",
    }),
  );
});
for (const url of [
  "http://preview-fixture.supabase.co",
  "http://127.0.0.1:54321",
  "https://localhost:54321",
  "https://preview-fixture.supabase.co/other",
  "https://user:password@preview-fixture.supabase.co",
  "https://preview-fixture.supabase.co?token=synthetic",
  "https://preview-fixture.supabase.co#fragment",
  "https://preview-fixture.supabase.co:444",
  "https://preview-fixture.supabase.co.attacker.test",
])
  test(`hosted configuration rejects unsafe origin ${url}`, () => {
    assert.throws(() => validateBrowserConfig(url, publicKey, "hosted"));
    assert.throws(() =>
      serverConfigFromEnv({ ...server, STOCKSHIFT_SUPABASE_URL: url }),
    );
  });
test("public and private keys cannot swap privilege boundaries", () => {
  const role = `a.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.b`;
  const anon = `a.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.b`;
  for (const key of [privateKey, role, "invalid", "a.malformed.b"])
    assert.throws(() => validateBrowserConfig(hosted, key, "hosted"));
  assert.equal(validateBrowserConfig(hosted, anon, "hosted").key, anon);
  assert.throws(() =>
    serverConfigFromEnv({
      ...server,
      STOCKSHIFT_SUPABASE_SECRET_KEY: publicKey,
    }),
  );
  assert.equal(serverConfigFromEnv(server).mode, "hosted");
});
test("private provider configuration with a Vite prefix fails instead of being shipped", () => {
  for (const name of [
    "VITE_STOCKSHIFT_OCR_TOKEN",
    "VITE_STOCKSHIFT_OCR_ENDPOINT",
    "VITE_STOCKSHIFT_SUPABASE_SECRET_KEY",
    "VITE_STOCKSHIFT_REPLAY",
  ])
    assert.throws(() =>
      browserConfigFromEnv({ ...browser, [name]: "synthetic-private" }, true),
    );
});
test("unknown configuration modes fail closed", () => {
  assert.throws(() =>
    browserConfigFromEnv({
      ...browser,
      VITE_STOCKSHIFT_SUPABASE_MODE: "automatic",
    }),
  );
  assert.throws(() =>
    serverConfigFromEnv({ ...server, STOCKSHIFT_SUPABASE_MODE: "automatic" }),
  );
});
test("deployment browser and API must share the same isolated project and public key", () => {
  const env = { ...browser, ...server };
  assert.doesNotThrow(() => validateDeploymentConfig(env));
  assert.throws(() =>
    validateDeploymentConfig({
      ...env,
      STOCKSHIFT_SUPABASE_URL: "https://other-fixture.supabase.co",
    }),
  );
  assert.throws(() =>
    validateDeploymentConfig({
      ...env,
      STOCKSHIFT_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_other",
    }),
  );
  assert.throws(() =>
    validateDeploymentConfig({ ...env, STOCKSHIFT_SUPABASE_SECRET_KEY: "" }),
  );
});
