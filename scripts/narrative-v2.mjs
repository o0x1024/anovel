import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  path.join(root, 'node_modules/.bin/jiti'),
  ['src/main/narrative-app/cli.ts', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
