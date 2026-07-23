import assert from 'node:assert/strict'

type InvokeCall = { channel: string; args: unknown[] }

const calls: InvokeCall[] = []
const responses = [
  { success: true, content: '第一轮修复正文' },
  {
    passed: false,
    blockers: ['提前越界：仍提前暴露猎尸队全貌'],
    warnings: [],
    execution: { passed: false, coverage: [] }
  },
  { success: true, content: '第二轮修复正文' },
  { passed: true, blockers: [], warnings: [], execution: { passed: true, coverage: [] } }
]

Object.assign(globalThis, {
  window: {
    anovel: {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        const response = responses.shift()
        if (!response) throw new Error('测试响应不足')
        return response
      }
    }
  }
})

async function main() {
  const { repairNovelExecutionUntilChecked } = await import(
    '../src/renderer/src/services/novel-execution-repair'
  )

  const candidates: string[] = []
  const rounds: number[] = []
  const result = await repairNovelExecutionUntilChecked({
    workId: 22,
    chapterId: 1634,
    content: '原始正文',
    blockers: ['情节缺失：R004'],
    maxRounds: 2,
    onRoundStart: round => rounds.push(round),
    onCandidate: content => candidates.push(content)
  })

  assert.equal(result.gate.passed, true)
  assert.equal(result.content, '第二轮修复正文')
  assert.equal(result.rounds, 2)
  assert.deepEqual(rounds, [1, 2])
  assert.deepEqual(candidates, ['第一轮修复正文', '第二轮修复正文'])
  assert.deepEqual(calls.map(call => call.channel), [
    'novel:repairExecutionCandidate',
    'consistency:gate',
    'novel:repairExecutionCandidate',
    'consistency:gate'
  ])
  assert.deepEqual(calls[2]?.args.slice(2), [
    '第一轮修复正文',
    ['提前越界：仍提前暴露猎尸队全貌']
  ])

  console.log('novel execution repair service regression passed')
}

void main()
