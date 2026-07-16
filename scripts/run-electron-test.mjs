import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
if (!target) throw new Error('缺少 Electron 测试文件路径')

const result = spawnSync(
  electronPath,
  [path.join(root, 'node_modules/jiti/bin/jiti.js'), path.resolve(root, target)],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
