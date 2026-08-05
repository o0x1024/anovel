import assert from 'node:assert/strict'
import { isProxy, reactive } from 'vue'
import { repairEmotionCandidateUntilChecked } from '../src/renderer/src/services/emotion-candidate-repair'
import type { EmotionBlindAssessment } from '../src/shared/emotion-contract'

function assessment(passed: boolean, score: number): EmotionBlindAssessment {
  return {
    passed,
    score,
    attachment_score: score,
    causal_earnedness_score: score,
    inferability_score: score,
    pov_immediacy_score: score,
    subtext_score: score,
    modulation_score: score,
    residue_score: score,
    target_alignment_score: score,
    actual_reader_curve: [],
    reader_cares_about: '主角能否脱身',
    reader_hopes: '主角主动反击',
    reader_fears: '资源耗尽',
    failure_layer: passed ? 'none' : 'scene',
    blocking_issues: passed ? [] : ['主角只后退等待'],
    repair_instruction: passed ? '' : '增加主动防御动作'
  }
}

async function main() {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const responses: unknown[] = [
    { success: true, content: '第一轮修复正文' },
    assessment(false, 78),
    { success: true, content: '第二轮修复正文' },
    assessment(true, 84)
  ]

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      anovel: {
        invoke: async (channel: string, ...args: unknown[]) => {
          if (channel === 'novel:repairEmotionCandidate') {
            assert.equal(isProxy(args[3]), false, 'Electron IPC 参数不得包含 Vue Proxy')
          }
          calls.push({ channel, args })
          return responses.shift()
        }
      }
    }
  })

  const candidates: string[] = []
  const initialAssessment = reactive(assessment(false, 77))
  const result = await repairEmotionCandidateUntilChecked({
    workId: 7,
    chapterId: 11,
    content: '原正文',
    assessment: initialAssessment,
    maxRounds: 2,
    onCandidate: content => candidates.push(content)
  })

  assert.equal(result.rounds, 2)
  assert.equal(result.assessment.passed, true)
  assert.equal(result.content, '第二轮修复正文')
  assert.deepEqual(candidates, ['第一轮修复正文', '第二轮修复正文'])
  assert.notEqual(calls[0].args[3], initialAssessment, '修复请求应使用独立的纯对象快照')
  assert.deepEqual(calls.map(item => item.channel), [
    'novel:repairEmotionCandidate',
    'emotion:assessChapter',
    'novel:repairEmotionCandidate',
    'emotion:assessChapter'
  ])
  for (const call of calls.filter(item => item.channel === 'emotion:assessChapter')) {
    assert.equal(call.args[3], false, '候选复验不得提前提交情绪账本')
    assert.equal(call.args[4], false, '候选复验不得提前持久化情绪评估')
  }

  console.log('情绪问题候选修复与有限轮次复验测试通过')
}

void main()
