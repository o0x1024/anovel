#!/usr/bin/env node
/**
 * Rebuild native addons for the bundled Electron runtime.
 * System Node (e.g. v24) and Electron (Node 20) use different ABI versions.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')
).version

const nativeModules = ['better-sqlite3']
const arch = process.arch
const distUrl = 'https://electronjs.org/headers'

for (const mod of nativeModules) {
  const modDir = join(root, 'node_modules', mod)
  if (!existsSync(join(modDir, 'binding.gyp'))) {
    console.log(`Skipping ${mod} (no binding.gyp)`)
    continue
  }
  console.log(`Rebuilding ${mod} for Electron ${electronVersion} (${arch})...`)
  execSync(
    `npx node-gyp rebuild --release --target=${electronVersion} --arch=${arch} --dist-url=${distUrl}`,
    { cwd: modDir, stdio: 'inherit' }
  )
}

console.log('Native modules rebuilt for Electron.')
