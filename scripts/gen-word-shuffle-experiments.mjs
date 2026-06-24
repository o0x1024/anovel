/**
 * 批量生成词级打乱实验样本 → docs/experiments/
 *
 * 用法:
 *   node scripts/gen-word-shuffle-experiments.mjs           # 关键基线样本
 *   node scripts/gen-word-shuffle-experiments.mjs --all     # 全部 experiments/*.txt
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { hashSeed, shuffleDocument } from './word-shuffle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')

const MODES = [
  { id: 'WS1', mode: 'full', label: '全token打乱(无语义)' },
  { id: 'WS2', mode: 'clause', label: '句内分句打乱' },
  { id: 'WS3', mode: 'phrase', label: '句内短语块打乱' },
  { id: 'WS4', mode: 'swap', label: '相邻词对交换32%' },
]

const BASELINE_FILES = [
  'A1-human.txt',
  'A2-ai.txt',
  'Q4-70human-30ai.txt',
  'Q6-50human-50ai.txt',
  'Q8-30human-70ai.txt',
  'Q10-10human-90ai.txt',
  'K2-50mix-human-tail.txt',
  'K4-50mix-interleave.txt',
  'K5-50mix-sandwich.txt',
  'H1-ai-lowfreq-vocab-only.txt',
  'E1-ai-colloquial-rewrite.txt',
  'M1-chatgpt.txt',
  'M2-claude.txt',
  'M4-deepseek.txt',
  'M6-glm.txt',
  'F1-ai-novel.txt',
  'D5-double-translate.txt',
  'D7-cascade-claude-to-deepseek.txt',
  'G1-genre-xianxia.txt',
  'G3-genre-mystery.txt',
  'G4-genre-scifi.txt',
  'X1-AI.txt',
]

function listSources(all) {
  if (all) {
    return fs
      .readdirSync(experimentsDir)
      .filter(f => f.endsWith('.txt') && !f.startsWith('WS'))
      .sort()
  }
  return BASELINE_FILES.filter(f => fs.existsSync(path.join(experimentsDir, f)))
}

function stripWsPrefix(name) {
  return name.replace(/^WS[1-4]-(?:full|clause|phrase|swap)-/, '')
}

function main() {
  const all = process.argv.includes('--all')
  const sources = listSources(all)
  const manifest = []

  for (const src of sources) {
    const inputPath = path.join(experimentsDir, src)
    const text = fs.readFileSync(inputPath, 'utf8').trimEnd()
    if (text.replace(/\s/g, '').length < 350) {
      console.log(`跳过 ${src} (<350字)`)
      continue
    }

    const base = src.replace(/\.txt$/, '')
    for (const { id, mode, label } of MODES) {
      const outName = `${id}-${mode}-${base}.txt`
      const outPath = path.join(experimentsDir, outName)
      const seed = hashSeed(`${base}:${mode}`)
      const out = shuffleDocument(text, mode, seed)
      fs.writeFileSync(outPath, out + '\n', 'utf8')
      manifest.push({ id, mode, label, source: src, output: outName, chars: out.replace(/\s/g, '').length })
      console.log(`✓ ${outName} ← ${src}`)
    }
  }

  const manifestPath = path.join(experimentsDir, 'WS-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`\n共生成 ${manifest.length} 个文件，清单: ${manifestPath}`)
}

main()
