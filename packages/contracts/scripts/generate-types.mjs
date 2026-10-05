import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { compileFromFile } from 'json-schema-to-typescript'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const schemas = path.join(root, 'packages/contracts/schemas/v1')
const types = path.join(root, 'packages/contracts/src/generated')
const python = path.join(root, 'services/worker/src/stockshift_worker/contracts/schemas/v1')
const check = process.argv.includes('--check')
const expectedTypes = []
const expectedSchemas = []

async function output(destination, contents) {
  if (check) {
    const existing = await readFile(destination, 'utf8').catch(() => '')
    if (existing !== contents) throw new Error(`Generated artifact out of date: ${path.relative(root, destination)}`)
  } else {
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, contents, 'utf8')
  }
}

for (const name of (await readdir(schemas)).filter(name => name.endsWith('.schema.json')).sort()) {
  const input = path.join(schemas, name)
  const contents = await readFile(input, 'utf8')
  // Wheel/Docker installs must work without the monorepo next to them.
  await output(path.join(python, name), contents)
  expectedSchemas.push(name)
  if (name === 'common.schema.json') continue
  const typeName = name.replace('.schema.json', '.ts')
  const generated = await compileFromFile(input, {
    cwd: schemas,
    bannerComment: '// Generated from schemas/v1. Run npm run contracts:generate; do not edit.',
    style: { singleQuote: true, semi: false },
  })
  await output(path.join(types, typeName), generated)
  expectedTypes.push(typeName)
}
// Detect obsolete copies after a schema is renamed/removed instead of silently shipping them.
for (const [directory, expected] of [[types, expectedTypes], [python, expectedSchemas]]) {
  const extra = (await readdir(directory)).filter(name => !expected.includes(name))
  if (extra.length) throw new Error(`Obsolete generated artifacts in ${directory}: ${extra.join(', ')}`)
}
console.log(check ? 'Generated types and packaged schemas are current.' : 'Generated types and packaged Python schemas.')
