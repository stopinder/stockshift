import { createHash } from 'node:crypto'
import { inspectWorkbook, XLSX_MIME } from './workbook.ts'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
export const BUCKET = 'catalogue-uploads'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class UploadError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
export type Role = 'owner' | 'editor' | 'viewer'
export interface SourceFile {
  id: string
  tenant_id: string
  created_by: string
  original_filename: string
  bucket_id: string
  object_name: string
  expected_byte_count: number
  status: 'pending' | 'verifying' | 'ready' | 'failed'
  byte_count: number | null
  verified_mime: string | null
  sha256: string | null
}
export interface Intent {
  tenantId: string
  filename: string
  byteCount: number
  supplierId: string | null
  importProfileId: string | null
}
export interface UploadGateway {
  authenticate(token: string): Promise<string>
  membership(tenantId: string, userId: string): Promise<Role | null>
  createIntent(input: Intent, token: string): Promise<SourceFile>
  signUpload(path: string, token: string): Promise<{ signedUrl: string; token: string }>
  transition(tenantId: string, fileId: string, actor: string, action: 'begin' | 'finish' | 'fail',
    verified?: { bytes: number; mime: string; sha256: string }): Promise<SourceFile>
  download(path: string): Promise<Blob>
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new UploadError(400, 'Invalid resource ID')
  return value
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UploadError(400, 'Invalid request')
  return input as Record<string, unknown>
}
export function parseIntent(input: unknown): Intent {
  const value = object(input)
  if (Object.keys(value).some(key => !['tenantId', 'filename', 'byteCount', 'supplierId', 'importProfileId'].includes(key))) {
    throw new UploadError(400, 'Unknown upload property')
  }
  const filename = value.filename
  if (typeof filename !== 'string' || filename.length > 255 || !/\.(csv|xlsx)$/i.test(filename)
    || /[/\\\x00-\x1f\x7f]/.test(filename)) throw new UploadError(400, 'Use a plain CSV or XLSX filename')
  const bytes = value.byteCount
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_UPLOAD_BYTES) {
    throw new UploadError(400, 'File size must be 1 byte to 10 MiB')
  }
  return { tenantId: id(value.tenantId), filename, byteCount: bytes,
    supplierId: value.supplierId == null ? null : id(value.supplierId),
    importProfileId: value.importProfileId == null ? null : id(value.importProfileId) }
}

async function authorize(gateway: UploadGateway, token: string, tenant: string): Promise<string> {
  if (!token || token.length > 8192) throw new UploadError(401, 'Authentication required')
  const actor = id(await gateway.authenticate(token))
  const role = await gateway.membership(tenant, actor)
  if (role !== 'owner' && role !== 'editor') throw new UploadError(403, 'Editor membership required')
  return actor
}
function registered(file: SourceFile, tenant: string, actor: string, fileId?: string): void {
  if (file.tenant_id !== tenant || file.created_by !== actor || (fileId && file.id !== fileId)
    || file.bucket_id !== BUCKET || file.object_name !== `${tenant}/${id(file.id)}/original`
    || !Number.isSafeInteger(file.expected_byte_count) || file.expected_byte_count < 1
    || file.expected_byte_count > MAX_UPLOAD_BYTES) throw new UploadError(403, 'Invalid registered upload')
}
function publicFile(file: SourceFile) {
  return { id: file.id, status: file.status, filename: file.original_filename,
    byteCount: file.byte_count, mime: file.verified_mime, sha256: file.sha256 }
}

export async function createUploadIntent(gateway: UploadGateway, token: string, input: unknown) {
  const request = parseIntent(input)
  const actor = await authorize(gateway, token, request.tenantId)
  const file = await gateway.createIntent(request, token)
  registered(file, request.tenantId, actor)
  if (file.status !== 'pending') throw new UploadError(409, 'Upload is not pending')
  const signed = await gateway.signUpload(file.object_name, token)
  return { fileId: file.id, bucket: BUCKET, path: file.object_name, ...signed }
}

export function verifyCsv(bytes: Uint8Array): { mime: string; sha256: string } {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new UploadError(422, 'Invalid uploaded byte count')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new UploadError(422, 'Only UTF-8 CSV uploads are currently supported') }
  if (!text.trim() || /^[\s\ufeff]*%PDF-/.test(text) || text.startsWith('PK\x03\x04')
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    throw new UploadError(422, 'Upload is not supported CSV text')
  }
  return { mime: 'text/csv', sha256: createHash('sha256').update(bytes).digest('hex') }
}

export async function finalizeUpload(gateway: UploadGateway, token: string, input: unknown) {
  const value = object(input)
  if (Object.keys(value).some(key => !['tenantId', 'fileId'].includes(key))) throw new UploadError(400, 'Unknown finalization property')
  const tenant = id(value.tenantId), fileId = id(value.fileId)
  const actor = await authorize(gateway, token, tenant)
  const file = await gateway.transition(tenant, fileId, actor, 'begin')
  registered(file, tenant, actor, fileId)
  if (file.status === 'ready') return publicFile(file)
  if (file.status !== 'verifying') throw new UploadError(409, 'Upload cannot be finalized')
  try {
    const blob = await gateway.download(file.object_name)
    if (blob.size !== file.expected_byte_count) throw new UploadError(422, 'Uploaded size differs from intent')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let verification: { mime: string; sha256: string }
    if (/\.xlsx$/i.test(file.original_filename)) {
      await inspectWorkbook(bytes)
      verification = { mime: XLSX_MIME, sha256: createHash('sha256').update(bytes).digest('hex') }
    } else verification = verifyCsv(bytes)
    const ready = await gateway.transition(tenant, fileId, actor, 'finish',
      { bytes: blob.size, ...verification })
    registered(ready, tenant, actor, fileId)
    if (ready.status !== 'ready') throw new UploadError(409, 'Upload did not finalize')
    return publicFile(ready)
  } catch (error) {
    // Never report ready if verification or durable finalization fails.
    await gateway.transition(tenant, fileId, actor, 'fail').catch(() => undefined)
    throw error
  }
}
