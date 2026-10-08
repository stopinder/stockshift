// An intentionally restricted CLI entry point. Never reads a project ref/key file.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
const allowed = [
  ['--help'], ['--version'], ['init'], ['start'], ['stop'],
  ['migration', '--help'], ['migration', 'new', '--help'],
  ['migration', 'up', '--help'], ['migration', 'up', '--local'],
  ['migration', 'up', '--local', '--include-all'],
  ['db', 'reset', '--help'], ['db', 'lint', '--help'], ['test', 'db', '--help'],
  ['db', 'advisors', '--help'], ['db', 'advisors', '--local'],
  ['db', 'reset', '--local'], ['db', 'lint', '--local'], ['migration', 'list', '--local'],
  ['status', '--output', 'json'],
]
const newMigration = args.length === 3 && args[0] === 'migration' && args[1] === 'new'
  && /^[a-z_]+$/.test(args[2])
if (!newMigration && !allowed.some(entry => JSON.stringify(entry) === JSON.stringify(args))) {
  throw new Error('Only allowlisted local Supabase commands are permitted')
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(SUPABASE_|PG|DATABASE_URL|STOCKSHIFT_LOCAL_SUPABASE_|STOCKSHIFT_SUPABASE_)/i.test(key)))
const root = fileURLToPath(new URL('../', import.meta.url))
if (existsSync(fileURLToPath(new URL('../supabase/.temp/project-ref', import.meta.url)))) {
  throw new Error('Refusing to use a checkout with a linked project reference')
}
const result = spawnSync(process.execPath,
  [fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url)), ...args, '--workdir', root],
  { env, stdio: 'inherit', cwd: root })
if (result.error) throw result.error
process.exit(result.status ?? 1)
