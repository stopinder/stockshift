import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BUCKET, UploadError, type Intent, type Role, type SourceFile, type UploadGateway } from './uploads'

export interface LocalSupabaseConfig { url: string; publishableKey: string; secretKey: string }
export function validateLocalConfig(config: LocalSupabaseConfig): LocalSupabaseConfig {
  const url = new URL(config.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== '54321' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('This increment permits only the loopback Supabase API on port 54321')
  }
  if (!config.publishableKey || !config.secretKey) throw new Error('Local server keys are required')
  return config
}
export function localConfigFromEnv(): LocalSupabaseConfig {
  return validateLocalConfig({ url: process.env.STOCKSHIFT_LOCAL_SUPABASE_URL ?? '',
    publishableKey: process.env.STOCKSHIFT_LOCAL_SUPABASE_PUBLISHABLE_KEY ?? '',
    secretKey: process.env.STOCKSHIFT_LOCAL_SUPABASE_SECRET_KEY ?? '' })
}
function result<T>(data: T | null, error: unknown): T {
  if (error || data === null) throw new UploadError(409, 'Upload storage/database operation failed')
  return data
}
export class SupabaseUploadGateway implements UploadGateway {
  private readonly admin: SupabaseClient
  constructor(private readonly config: LocalSupabaseConfig) {
    validateLocalConfig(config)
    this.admin = this.client(config.secretKey)
  }
  private client(key: string, token?: string): SupabaseClient {
    return createClient(this.config.url, key, { auth: { persistSession: false, autoRefreshToken: false,
      detectSessionInUrl: false }, ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}) })
  }
  async authenticate(token: string): Promise<string> {
    const { data, error } = await this.client(this.config.publishableKey, token).auth.getUser(token)
    if (error || !data.user || data.user.is_anonymous) throw new UploadError(401, 'Invalid authentication')
    return data.user.id
  }
  async membership(tenant: string, actor: string): Promise<Role | null> {
    const { data, error } = await this.admin.from('tenant_memberships').select('role')
      .eq('tenant_id', tenant).eq('user_id', actor).maybeSingle()
    if (error) throw new UploadError(503, 'Membership lookup unavailable')
    return data?.role ?? null
  }
  async createIntent(input: Intent, token: string): Promise<SourceFile> {
    const { data, error } = await this.client(this.config.publishableKey, token).rpc('create_upload_intent', {
      p_tenant: input.tenantId, p_filename: input.filename, p_bytes: input.byteCount,
      p_supplier: input.supplierId, p_profile: input.importProfileId })
    return result(data, error) as SourceFile
  }
  async signUpload(path: string, token: string) {
    // Sign as the user, preserving Storage owner_id. Never allow replacement.
    const { data, error } = await this.client(this.config.publishableKey, token).storage
      .from(BUCKET).createSignedUploadUrl(path, { upsert: false })
    const signed = result(data, error)
    return { signedUrl: signed.signedUrl, token: signed.token }
  }
  async transition(tenant: string, file: string, actor: string, action: 'begin' | 'finish' | 'fail',
    verified?: { bytes: number; mime: string; sha256: string }): Promise<SourceFile> {
    const { data, error } = await this.admin.rpc('transition_catalogue_upload', {
      p_tenant: tenant, p_file: file, p_actor: actor, p_action: action,
      p_bytes: verified?.bytes ?? null, p_mime: verified?.mime ?? null, p_sha: verified?.sha256 ?? null })
    return result(data, error) as SourceFile
  }
  async download(path: string): Promise<Blob> {
    const { data, error } = await this.admin.storage.from(BUCKET).download(path)
    return result(data, error)
  }
}
