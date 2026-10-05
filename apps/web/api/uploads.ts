import type { IncomingMessage, ServerResponse } from 'node:http'
import { createUploadIntent, finalizeUpload, UploadError } from '../server/uploads'
import { localConfigFromEnv, SupabaseUploadGateway } from '../server/supabase-upload-gateway'

// Vercel parses JSON bodies. Browser shell intentionally has no upload/auth flow.
export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json')
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.statusCode = 405; res.end('{}'); return }
  try {
    const authorization = req.headers.authorization
    if (!authorization?.startsWith('Bearer ')) throw new UploadError(401, 'Authentication required')
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new UploadError(400, 'Expected JSON body')
    const { action, ...input } = body as Record<string, unknown>
    if (action !== 'create' && action !== 'finalize') throw new UploadError(400, 'Unknown upload action')
    const gateway = new SupabaseUploadGateway(localConfigFromEnv())
    const output = action === 'create'
      ? await createUploadIntent(gateway, authorization.slice(7), input)
      : await finalizeUpload(gateway, authorization.slice(7), input)
    res.statusCode = action === 'create' ? 201 : 200
    res.end(JSON.stringify(output))
  } catch (error) {
    res.statusCode = error instanceof UploadError ? error.status : 503
    res.end(JSON.stringify({ error: error instanceof UploadError ? error.message : 'Upload service unavailable' }))
  }
}
