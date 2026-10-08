// Shared browser/server validation. No credentials are logged or embedded here.
import { hostedPdfCapabilities } from "./pdf-capabilities.ts";
export type SupabaseMode = "local" | "hosted";
export function validateSupabaseUrl(url: string, mode: string = "local") {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Supabase URL is missing or invalid");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error("Supabase URL must be an origin without credentials");
  if (mode === "local") {
    if (
      parsed.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
      parsed.port !== "54321"
    )
      throw new Error("Local Supabase configuration required");
  } else if (mode === "hosted") {
    if (
      parsed.protocol !== "https:" ||
      parsed.port ||
      !/^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)
    )
      throw new Error("Hosted Supabase requires its HTTPS project origin");
  } else throw new Error("Supabase mode must be local or hosted");
  return url;
}
function legacyRole(key: string): unknown {
  if (key.split(".").length !== 3) return null;
  try {
    return JSON.parse(
      atob(key.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    ).role;
  } catch {
    return null;
  }
}
export function validatePublicKey(key: string) {
  if (
    !key ||
    !(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) || legacyRole(key) === "anon")
  )
    throw new Error("Browser requires a publishable or anonymous public key");
  return key;
}
export function validateServerKey(key: string) {
  if (
    !key ||
    !(
      /^sb_secret_[A-Za-z0-9_-]+$/.test(key) ||
      legacyRole(key) === "service_role"
    )
  )
    throw new Error("Server requires a secret or service-role key");
  return key;
}
export function validateBrowserConfig(
  url: string,
  key: string,
  mode: string = "local",
) {
  validateSupabaseUrl(url, mode);
  validatePublicKey(key);
  return { url, key };
}
export function browserConfigFromEnv(
  env: Record<string, unknown>,
  vercelBuild = false,
) {
  const mode = env.VITE_STOCKSHIFT_SUPABASE_MODE ?? "local";
  if (mode === "hosted") hostedPdfCapabilities(env, "VITE_");
  if (vercelBuild && mode !== "hosted")
    throw new Error("Vercel requires explicit hosted Supabase configuration");
  // Known private configuration names must never be given a public Vite prefix.
  if (
    Object.keys(env).some(
      (key) =>
        key.startsWith("VITE_") &&
        /(?:SECRET|SERVICE_ROLE|TOKEN|PASSWORD|PRIVATE|OCR_ENDPOINT|REPLAY)/.test(
          key,
        ) &&
        env[key],
    )
  )
    throw new Error("Private service configuration must stay server-side");
  const prefix = mode === "local" ? "VITE_STOCKSHIFT_LOCAL" : "VITE_STOCKSHIFT";
  return validateBrowserConfig(
    String(env[`${prefix}_SUPABASE_URL`] ?? ""),
    String(env[`${prefix}_SUPABASE_PUBLISHABLE_KEY`] ?? ""),
    String(mode),
  );
}
