#!/usr/bin/env node

/** 对 OpenAI 兼容微调模型运行封存续写集，并输出可供人工/外部检测盲测的结果。 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const options = { input: '', output: '', apiBase: '', model: '', apiKeyEnv: '', limit: 0, temperature: 0.8 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--input' && value) options.input = path.resolve(value), i++
    else if (arg === '--output' && value) options.output = path.resolve(value), i++
    else if (arg === '--api-base' && value) options.apiBase = value.replace(/\/+$/, ''), i++
    else if (arg === '--model' && value) options.model = value, i++
    else if (arg === '--api-key-env' && value) options.apiKeyEnv = value, i++
    else if (arg === '--limit' && value) options.limit = Number(value), i++
    else if (arg === '--temperature' && value) options.temperature = Number(value), i++
    else throw new Error(`未知或缺值参数：${arg}`)
  }
  return options
}

function bigramRecall(reference, candidate) {
  const ref = reference.replace(/\s/g, '')
  const output = candidate.replace(/\s/g, '')
  if (ref.length < 2 || output.length < 2) return 0
  const refBigrams = new Set()
  for (let i = 0; i < ref.length - 1; i++) refBigrams.add(ref.slice(i, i + 2))
  let shared = 0
  for (let i = 0; i < output.length - 1; i++) if (refBigrams.has(output.slice(i, i + 2))) shared++
  return shared / (output.length - 1)
}

function longestCommonSubstring(a, b) {
  const left = a.replace(/\s/g, '')
  const right = b.replace(/\s/g, '')
  let previous = new Uint32Array(right.length + 1)
  let best = 0
  for (let i = 1; i <= left.length; i++) {
    const current = new Uint32Array(right.length + 1)
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

async function generate(options, messages) {
  const apiKey = options.apiKeyEnv ? process.env[options.apiKeyEnv] : ''
  if (options.apiKeyEnv && !apiKey) throw new Error(`环境变量 ${options.apiKeyEnv} 未设置`)
  const response = await fetch(`${options.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({
      model: options.model,
      messages: messages.slice(0, 2),
      temperature: options.temperature,
      max_tokens: 1600,
      stream: false
    })
  })
  if (!response.ok) throw new Error(`模型请求失败 ${response.status}: ${(await response.text()).slice(0, 500)}`)
  const body = await response.json()
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回正文')
  return content.trim()
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.input || !options.output || !options.apiBase || !options.model) {
    throw new Error('必须提供 --input test.jsonl --output result.jsonl --api-base URL --model MODEL')
  }
  const rows = fs.readFileSync(options.input, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  const selected = options.limit > 0 ? rows.slice(0, options.limit) : rows
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  const results = []
  for (let index = 0; index < selected.length; index++) {
    const row = selected[index]
    const target = row.messages?.[2]?.content ?? ''
    const generated = await generate(options, row.messages)
    const result = {
      index,
      prompt: row.messages?.[1]?.content ?? '',
      target,
      generated,
      generatedChars: generated.replace(/\s/g, '').length,
      targetBigramRecall: Math.round(bigramRecall(target, generated) * 10000) / 10000,
      longestTargetOverlap: longestCommonSubstring(target, generated),
      humanReview: null,
      externalDetectors: []
    }
    results.push(result)
    console.log(`[${index + 1}/${selected.length}] ${result.generatedChars}字，目标最长重合 ${result.longestTargetOverlap}字`)
  }
  fs.writeFileSync(options.output, `${results.map(result => JSON.stringify(result)).join('\n')}\n`)
  const summary = {
    model: options.model,
    apiBase: options.apiBase,
    input: options.input,
    samples: results.length,
    averageGeneratedChars: Math.round(results.reduce((sum, row) => sum + row.generatedChars, 0) / Math.max(1, results.length)),
    maxTargetOverlap: Math.max(...results.map(row => row.longestTargetOverlap), 0),
    note: '外部检测与人工盲评字段必须在生成后独立填写，不参与模型选择。'
  }
  fs.writeFileSync(`${options.output}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`)
}

main()
