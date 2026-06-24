/**
 * 策略 C：V3 后修复（DeepSeek 最小限度修复）
 *
 * 从 V3（100%人工，50%扰动）出发，让 DeepSeek 做最小限度调整恢复可读性。
 *
 * 用法: node scripts/sr30-repair.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')
const INPUT = path.join(experimentsDir, 'V3-SR30-narr-swap50.txt')

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODEL = 'deepseek-chat'

function makeRepairPrompt(maxPairs) {
  return [
    '以下中文的词语位置被打乱了。请做最小限度的调整使其可读。',
    '',
    '严格规则：',
    '1. 只能交换词语位置来修复，不能替换词、加词或删词',
    '2. 优先修复人名位置和句子主语位置',
    `3. 每个句子最多交换${maxPairs}对词语的位置`,
    '4. 不要把所有语序都恢复成标准中文，保留不常见但能理解的表达',
    '5. 仅输出修复后的文本，不要加任何解释或标记',
    '6. 保持原文的换行格式',
  ].join('\n')
}

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const dbPath = path.join(os.homedir(), 'Library/Application Support/anovel/anovel.db')
  if (!fs.existsSync(dbPath)) throw new Error('请设置 DEEPSEEK_API_KEY')
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT api_key FROM model_configs WHERE model_type = 'deepseek' AND is_enabled = 1"`,
      { encoding: 'utf8' }
    ).trim()
    if (!result) throw new Error('空结果')
    return result
  } catch {
    throw new Error('无法读取 API key，请设置 DEEPSEEK_API_KEY')
  }
}

async function callDeepSeek(apiKey, systemPrompt, userText) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature: 0.3,
    max_tokens: 4096,
  }
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`DeepSeek ${resp.status}: ${text}`)
  }
  const json = await resp.json()
  return json.choices?.[0]?.message?.content?.trim() ?? ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isDialogueLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^["\u201c\u300c]/.test(trimmed)) return true
  if (trimmed.length <= 6) return true
  return false
}

async function main() {
  const text = fs.readFileSync(INPUT, 'utf8').trimEnd()
  const lines = text.split('\n')
  console.log(`输入: V3-SR30-narr-swap50 (${text.replace(/\s/g, '').length} 字, ${lines.length} 行)\n`)

  const apiKey = getDeepSeekApiKey()
  console.log('DeepSeek API key 已获取\n')

  for (const [label, maxPairs] of [['SC1', 3], ['SC2', 2]]) {
    console.log(`=== ${label}: 每句最多修 ${maxPairs} 对 ===`)
    const prompt = makeRepairPrompt(maxPairs)

    // Group narrative paragraphs into batches of 5 for efficiency
    const resultLines = [...lines]
    const narrativeGroups = []
    let currentGroup = []
    let currentStartIdx = -1

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed || isDialogueLine(trimmed)) {
        if (currentGroup.length > 0) {
          narrativeGroups.push({ startIdx: currentStartIdx, lines: [...currentGroup] })
          currentGroup = []
        }
        continue
      }
      if (currentGroup.length === 0) currentStartIdx = i
      currentGroup.push({ idx: i, text: lines[i] })
    }
    if (currentGroup.length > 0) {
      narrativeGroups.push({ startIdx: currentStartIdx, lines: [...currentGroup] })
    }

    let repaired = 0
    for (const group of narrativeGroups) {
      const groupText = group.lines.map(l => l.text).join('\n')
      try {
        const result = await callDeepSeek(apiKey, prompt, groupText)
        if (result) {
          const resultParts = result.split('\n').filter(l => l.trim())
          for (let j = 0; j < group.lines.length && j < resultParts.length; j++) {
            resultLines[group.lines[j].idx] = resultParts[j]
          }
          repaired += group.lines.length
        }
      } catch (err) {
        console.error(`  修复失败: ${err.message}`)
      }
      await sleep(500)
    }

    console.log(`  修复 ${repaired} 行叙述段落`)

    const outText = resultLines.join('\n')
    const outPath = path.join(experimentsDir, `${label}-SR30-repaired.txt`)
    fs.writeFileSync(outPath, outText + '\n', 'utf8')
    console.log(`  ✓ ${label} → ${outPath}\n`)
  }

  console.log('完成！')
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
