import assert from 'node:assert/strict'
import {
  validateStoryComplianceEvidence,
  validateStoryReleasePromiseEvidence,
  type StoryReleaseEvidence
} from '../src/main/context/goal-routine/story-release-review'
import { parseForensicEvidence } from '../src/main/context/goal-routine/story-whole-evaluator'

const source: StoryReleaseEvidence = {
  title: '她拒绝签字后',
  hook: '所有人都等着她低头。',
  firstThirtyPercent: '会议室里，所有人都等着她低头。她把合同推了回去。',
  climaxWindow: '她当众拒绝签字，拿出已经公证的录音。',
  ending: '裁定送达后，她离开公司，没有回头。',
  fullBody: [
    '会议室里，所有人都等着她低头。她把合同推了回去。',
    '她当众拒绝签字，拿出已经公证的录音。',
    '裁定送达后，她离开公司，没有回头。'
  ].join('\n')
}

const promise = validateStoryReleasePromiseEvidence({
  passed: true,
  title_promise: '她拒绝签字',
  hook_promise: '她是否低头',
  first_thirty_percent_evidence: ['她把合同推了回去'],
  climax_evidence: ['她当众拒绝签字'],
  ending_evidence: ['她离开公司，没有回头'],
  missing_promises: []
}, source)
assert.equal(promise.passed, true)

assert.throws(() => validateStoryReleasePromiseEvidence({
  passed: true,
  title_promise: '她拒绝签字',
  hook_promise: '她是否低头',
  first_thirty_percent_evidence: ['她愤怒地撕碎合同'],
  climax_evidence: ['她当众拒绝签字'],
  ending_evidence: ['她离开公司，没有回头'],
  missing_promises: []
}, source), /无法在对应原文定位/)

assert.throws(() => validateStoryComplianceEvidence({
  passed: false,
  issues: [{
    code: 'LEGAL_PROCESS_FALSE',
    domain: 'legal',
    evidence: '警方当场判决她胜诉',
    message: '程序错误',
    required_action: '改为法院裁定'
  }]
}, source.fullBody), /无法在对应原文定位/)

const blocks = [
  { title: '第一拍', text: '她把合同推了回去。' },
  { title: '第二拍', text: '她拿出已经公证的录音。' }
]
const forensic = parseForensicEvidence(JSON.stringify({
  hard_blockers: [{
    code: 'EVIDENCE_STATE_REGRESSION',
    claim_key: 'RECORDING_OWNERSHIP_REGRESSION',
    scope: 'beat_cluster',
    chapter_titles: ['第二拍'],
    repair_chapter_titles: ['第一拍', '第二拍'],
    evidence: ['她拿出已经公证的录音'],
    message: '录音此前没有交代来源',
    repairable: true,
    recommended_action: '在第一拍补足录音取得动作'
  }]
}), blocks, blocks.map(block => block.text).join('\n'))
assert.equal(forensic[0]?.claimKey, 'RECORDING_OWNERSHIP_REGRESSION')

assert.throws(() => parseForensicEvidence(JSON.stringify({
  hard_blockers: ['录音来源不明']
}), blocks, blocks.map(block => block.text).join('\n')), /不是结构化问题对象/)

assert.throws(() => parseForensicEvidence(JSON.stringify({
  hard_blockers: [{
    code: 'EVIDENCE_STATE_REGRESSION',
    claim_key: 'RECORDING_OWNERSHIP_REGRESSION',
    scope: 'beat_cluster',
    chapter_titles: ['第二拍'],
    repair_chapter_titles: ['第一拍', '第二拍'],
    evidence: ['她从保险柜取出录音'],
    message: '录音此前没有交代来源',
    repairable: true,
    recommended_action: '在第一拍补足录音取得动作'
  }]
}), blocks, blocks.map(block => block.text).join('\n')), /缺少可在原文定位的证据/)

console.log('story release evidence binding tests passed')
