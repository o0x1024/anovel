import assert from 'node:assert/strict'

const calls: Array<{ channel: string; args: unknown[] }> = []
Object.assign(globalThis, {
  window: {
    anovel: {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args })
        return true
      }
    }
  }
})

async function main() {
  const { saveChapterDraft } = await import('../src/renderer/src/services/chapter-draft-save')

  const novel = await saveChapterDraft(1634, 'novel', '第一段。\n\n第二段。')
  assert.equal(novel.status, 'memory_pending')
  assert.equal(novel.cleared, false)
  assert.equal(novel.wordCount, 8)

  const story = await saveChapterDraft(2001, 'story', '')
  assert.equal(story.status, 'draft')
  assert.equal(story.cleared, true)
  assert.equal(story.wordCount, 0)

  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.channel === 'chapter:update'))
  assert.deepEqual(calls[0]?.args, [1634, {
    content: '第一段。\n第二段。',
    word_count: 8,
    status: 'memory_pending'
  }])

  console.log('chapter draft save service regression passed')
}

void main()
