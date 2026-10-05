import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const root = fileURLToPath(new URL('../', import.meta.url))
if (existsSync(new URL('../supabase/.temp/project-ref', import.meta.url))) {
  throw new Error('Refusing verification in a linked checkout')
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_)/i.test(key)))
env.STOCKSHIFT_TEST_LOCAL_POSTGRES = '1'
for (const args of [
  ['--test', 'supabase/tests/security.test.mjs'],
  ['--test', 'supabase/tests/jobs.local.mjs'],
  ['--test', 'supabase/tests/review.local.mjs'],
  ['--test', 'supabase/tests/pdf.local.mjs'],
  ['--test', 'supabase/tests/ocr.local.mjs'],
  ['--import', 'tsx', '--test', 'supabase/tests/upload.local.ts'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
