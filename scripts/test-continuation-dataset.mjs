#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anovel-continuation-test-'))
const source = path.join(temp, 'authorized.txt')
const output = path.join(temp, 'dataset')
const chapterChars = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const corpus = chapterChars.map((char, index) =>
  `第${index + 1}章 测试章节\n${(char + '起身。' + char + '看见门外。').repeat(180)}`
).join('\n')
fs.writeFileSync(source, corpus)

const result = spawnSync(process.execPath, [
  'scripts/gen-sft-dataset.mjs',
  '--source', source,
  '--out-dir', output,
  '--context-chars', '420',
  '--target-chars', '240',
  '--stride-chars', '500',
  '--leakage-chars', '80'
], { cwd: root, encoding: 'utf8' })

assert.equal(result.status, 0, result.stderr)
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'))
assert.ok(manifest.counts.train > 0)
assert.ok(manifest.counts.validation > 0)
assert.ok(manifest.counts.test > 0)
assert.equal(manifest.splitPolicy, 'chapter-first-contiguous-80-10-10')

for (const split of ['train', 'validation', 'test']) {
  const rows = fs.readFileSync(path.join(output, `${split}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(rows.every(row => row.messages?.[1]?.content.startsWith('【连续前文】')))
  assert.ok(rows.every(row => row.messages?.[2]?.content.length >= 180))
}

console.log('连续章节SFT数据集测试通过')
