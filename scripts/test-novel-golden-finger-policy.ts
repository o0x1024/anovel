import assert from 'node:assert/strict'
import { shouldGenerateNovelGoldenFinger } from '../src/main/context/goal-routine/novel-golden-finger-policy'

assert.equal(shouldGenerateNovelGoldenFinger({
  userRequired: true,
  goal: '纯现实题材',
  mainline: ''
}), true)

assert.equal(shouldGenerateNovelGoldenFinger({
  userRequired: false,
  goal: '末世捡垃圾，通过万物回收系统兑换物品',
  mainline: ''
}), true)

assert.equal(shouldGenerateNovelGoldenFinger({
  userRequired: false,
  goal: '现实主义家庭故事',
  mainline: '普通人依靠经验解决问题'
}), false)

console.log('novel golden finger policy tests passed')
