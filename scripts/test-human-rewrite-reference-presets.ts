import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { HUMAN_REWRITE_REFERENCE_PRESETS } from '../src/shared/human-rewrite-reference-presets'
import { HUMAN_REWRITE_SCENE_TYPES } from '../src/shared/human-rewrite-reference-types'

const sourcePath = path.resolve('docs/我不过作作妖，怎么就成了白月光.txt')
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\s+/g, '')
const preset = HUMAN_REWRITE_REFERENCE_PRESETS.find(item => item.id === 'baiyueguang-human-rewrite')

assert.ok(preset, '必须提供《白月光》人工化改写案例预设')
assert.equal(preset.examples.length, 10, '预设应覆盖十类主要场景')

const coveredScenes = new Set(preset.examples.flatMap(item => item.sceneTypes))
for (const sceneType of HUMAN_REWRITE_SCENE_TYPES) {
  assert.ok(coveredScenes.has(sceneType), `预设缺少场景类型：${sceneType}`)
}

const titles = new Set<string>()
for (const example of preset.examples) {
  assert.ok(!titles.has(example.title), `案例名称重复：${example.title}`)
  titles.add(example.title)
  assert.ok(example.originalText.trim() !== example.rewrittenText.trim(), `${example.title} 不是有效成对案例`)
  assert.ok(example.rewritePrinciples.length >= 2, `${example.title} 缺少可执行改写原则`)
  assert.ok(example.preservedFacts.length > 0, `${example.title} 缺少必须保留事实`)
  assert.ok(example.forbiddenChanges.length > 0, `${example.title} 缺少禁止变化约束`)
  assert.ok(
    source.includes(example.rewrittenText.replace(/\s+/g, '')),
    `${example.title} 的人类改写后文本不是来源小说中的连续原文`
  )
}

console.log('《白月光》十类场景人工化改写案例预设测试通过')

