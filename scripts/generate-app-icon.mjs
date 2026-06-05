#!/usr/bin/env node
/**
 * Renders build/icon.svg → PNG sizes + macOS .icns + Windows .ico
 * Requires: npx sharp (dev, pulled on first run)
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const svgPath = join(buildDir, 'icon.svg')
const iconsetDir = join(buildDir, 'icon.iconset')

const SIZES = [16, 32, 64, 128, 256, 512, 1024]

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: root })
}

async function renderPng(size, outPath) {
  const sharp = (await import('sharp')).default
  await sharp(svgPath).resize(size, size).png().toFile(outPath)
}

if (!existsSync(svgPath)) {
  console.error('Missing build/icon.svg')
  process.exit(1)
}

mkdirSync(buildDir, { recursive: true })

console.log('Rendering master PNG (1024)...')
await renderPng(1024, join(buildDir, 'icon.png'))

if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true })
mkdirSync(iconsetDir)

console.log('Building iconset...')
for (const size of SIZES) {
  const base = join(iconsetDir, `icon_${size}x${size}.png`)
  await renderPng(size, base)
  if (size <= 512) {
    const dbl = size * 2
    await renderPng(dbl, join(iconsetDir, `icon_${size}x${size}@2x.png`))
  }
}

console.log('Creating icon.icns...')
run(`iconutil -c icns "${iconsetDir}" -o "${join(buildDir, 'icon.icns')}"`)

rmSync(iconsetDir, { recursive: true })
console.log('Done: build/icon.png, build/icon.icns (electron-builder also accepts PNG for Windows)')
