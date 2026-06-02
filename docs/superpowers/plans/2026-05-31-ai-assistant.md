# AI 助手模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ANovel 中新增顶级「AI 助手」模块（`/assistant`），支持外部文档上传、角色化 IM 对话、文风分析结构化输出，并一键写入文风管理。

**Architecture:** 独立 SQLite 表（roles/documents/conversations/messages），主进程 `ipc-assistant.ts` + `assistant-chat.ts` 编排模型调用；流式通过 `assistant:delta` 事件推送（与 Editor 的 `ai:delta` 隔离）；前端三栏 IM 布局 + `useAssistantChat` composable。

**Tech Stack:** Electron + Vue 3 + TypeScript + better-sqlite3 + 现有 `modelService.chat` + DaisyUI

**Spec:** `docs/superpowers/specs/2026-05-31-ai-assistant-design.md`

---

## File Map

| 路径 | 职责 |
|------|------|
| `src/main/db/migrations.ts` | 增量创建 assistant 四表 |
| `src/main/db/dao/assistant-role-dao.ts` | 角色 CRUD |
| `src/main/db/dao/assistant-document-dao.ts` | 外部文档 CRUD |
| `src/main/db/dao/assistant-conversation-dao.ts` | 会话 CRUD |
| `src/main/db/dao/assistant-message-dao.ts` | 消息 CRUD |
| `src/main/db/assistant-seed.ts` | 内置角色 seed |
| `src/main/context/assistant/document-sampling.ts` | 长文抽样 |
| `src/main/context/assistant/style-analysis-parser.ts` | JSON 提取与校验 |
| `src/main/context/assistant/assistant-chat.ts` | 对话编排 + 流式 |
| `src/main/context/assistant/types.ts` | 共享类型 |
| `src/main/ipc-assistant.ts` | IPC 注册 |
| `src/main/ipc.ts` | 调用 `registerAssistantIpcHandlers()` |
| `src/main/db/index.ts` | 导出 DAO |
| `src/main/index.ts` | 启动时 `seedAssistantRoles()` |
| `src/renderer/src/router/index.ts` | `/assistant` 路由 |
| `src/renderer/src/components/AppLayout.vue` | 导航项 |
| `src/renderer/src/composables/useAssistantChat.ts` | 前端 IPC + 事件 |
| `src/renderer/src/views/assistant/AssistantHub.vue` | 三栏容器 |
| `src/renderer/src/views/assistant/AssistantConversationList.vue` | 左栏 |
| `src/renderer/src/views/assistant/AssistantMessageList.vue` | 消息区 |
| `src/renderer/src/views/assistant/AssistantMessageInput.vue` | 输入区 |
| `src/renderer/src/views/assistant/cards/StyleAnalysisCard.vue` | 文风卡片 |
| `src/renderer/src/views/assistant/AssistantRoleManager.vue` | Phase 2 |

---

## Task 1: 数据库迁移与类型定义

**Files:**
- Create: `src/main/context/assistant/types.ts`
- Modify: `src/main/db/migrations.ts`

- [ ] **Step 1: 创建共享类型**

```typescript
// src/main/context/assistant/types.ts
export interface StyleAnalysisResult {
  styleName: string
  description: string
  dimensions: {
    sentenceRhythm: string
    dialogueStyle: string
    narrativeDistance: string
    rhetoricPrefs: string[]
    pacing: string
    vocabularyNotes: string
    taboos: string[]
  }
  promptTemplate: string
  sampleExcerpts: string[]
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
}

export type AssistantMessageType = 'text' | 'attachment' | 'tool_result'
export type AssistantMessageRole = 'user' | 'assistant' | 'system'

export interface AssistantRoleRow {
  id: number
  name: string
  description: string | null
  icon: string
  system_prompt: string
  analysis_rules_json: string | null
  capabilities_json: string | null
  is_builtin: number
  create_time: string
  update_time: string
}
```

- [ ] **Step 2: 在 migrations.ts 末尾追加四表**

在 `ensureIncrementalMigrations` 函数末尾添加：

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS assistant_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(80) NOT NULL,
      description TEXT,
      icon VARCHAR(40) NOT NULL DEFAULT 'robot',
      system_prompt TEXT NOT NULL,
      analysis_rules_json TEXT,
      capabilities_json TEXT,
      is_builtin INTEGER DEFAULT 0,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assistant_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title VARCHAR(200) NOT NULL,
      file_name VARCHAR(200),
      content_text TEXT NOT NULL,
      char_count INTEGER DEFAULT 0,
      fingerprint_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assistant_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER NOT NULL,
      title VARCHAR(200) NOT NULL DEFAULT '新对话',
      document_ids_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      update_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (role_id) REFERENCES assistant_roles(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS assistant_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      message_type VARCHAR(20) NOT NULL DEFAULT 'text',
      metadata_json TEXT,
      create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
    );
  `)
```

- [ ] **Step 3: 验证构建**

Run: `npm run build`  
Expected: exit 0

---

## Task 2: DAO 层

**Files:**
- Create: `src/main/db/dao/assistant-role-dao.ts`
- Create: `src/main/db/dao/assistant-document-dao.ts`
- Create: `src/main/db/dao/assistant-conversation-dao.ts`
- Create: `src/main/db/dao/assistant-message-dao.ts`
- Modify: `src/main/db/index.ts`

- [ ] **Step 1: assistant-role-dao.ts**

参照 `style-dao.ts` 的 `BaseDAO` 模式，实现：
- `list()`, `getById(id)`, `create(input)`, `update(id, input)`, `delete(id)`（删除前检查 `is_builtin !== 1`）
- `clone(id, newName)` — SELECT 后 INSERT 新行，`is_builtin: 0`

- [ ] **Step 2: assistant-document-dao.ts**

- `create({ title, file_name?, content_text })` — 写入时 `char_count = content_text.length`，调用 `extractStyleFingerprint` 写入 `fingerprint_json`
- `list()`, `getById`, `delete`

- [ ] **Step 3: assistant-conversation-dao.ts**

- `list()`, `create({ role_id, title?, document_ids? })`, `updateTitle`, `touch(id)`, `delete`

- [ ] **Step 4: assistant-message-dao.ts**

- `listByConversation(conversationId)`, `create({ conversation_id, role, content, message_type, metadata_json })`, `updateContent(id, content, metadata_json?)`, `deleteByConversation`

- [ ] **Step 5: 在 db/index.ts 导出**

```typescript
export { assistantRoleDAO } from './dao/assistant-role-dao'
export { assistantDocumentDAO } from './dao/assistant-document-dao'
export { assistantConversationDAO } from './dao/assistant-conversation-dao'
export { assistantMessageDAO } from './dao/assistant-message-dao'
```

- [ ] **Step 6: 验证构建**

Run: `npm run build`  
Expected: exit 0

---

## Task 3: 内置角色 Seed

**Files:**
- Create: `src/main/db/assistant-seed.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: assistant-seed.ts**

```typescript
import { assistantRoleDAO } from './dao/assistant-role-dao'

const BUILTIN_ROLES = [
  {
    name: '文风分析师',
    description: '分析外部作品，提炼文风并导出到文风管理',
    icon: 'palette',
    system_prompt: `你是 ANovel 的文风分析师。...`, // 见 spec §6.2 完整文本
    analysis_rules_json: JSON.stringify([
      '重点分析句长节奏、对话密度、叙述距离',
      '输出可执行的 Prompt 模板，避免空泛形容词',
      '在需要保存文风时输出 StyleAnalysisResult JSON 代码块'
    ]),
    capabilities_json: JSON.stringify(['style_export']),
    is_builtin: 1
  },
  {
    name: '自由创作顾问',
    description: '写作技巧、改稿建议与创作讨论',
    icon: 'feather-alt',
    system_prompt: `你是 ANovel 的创作顾问，用中文简洁回答用户的写作问题。不要输出 JSON 结构化块。`,
    analysis_rules_json: null,
    capabilities_json: JSON.stringify([]),
    is_builtin: 1
  }
]

export function seedAssistantRoles(): void {
  for (const role of BUILTIN_ROLES) {
    const existing = assistantRoleDAO.list().find(r => r.name === role.name && r.is_builtin)
    if (!existing) assistantRoleDAO.create(role)
  }
}
```

- [ ] **Step 2: 在 index.ts initSchema 之后调用 `seedAssistantRoles()`**

- [ ] **Step 3: 验证**

Run: `npm run dev`，打开 DB 或 IPC 调试，确认 `assistant:roleList` 返回 2 条（实现 IPC 前可用临时脚本或下一步一并验证）

---

## Task 4: 文档抽样与 JSON 解析

**Files:**
- Create: `src/main/context/assistant/document-sampling.ts`
- Create: `src/main/context/assistant/style-analysis-parser.ts`

- [ ] **Step 1: document-sampling.ts**

```typescript
export function sampleDocumentText(fullText: string, maxChars = 4000): string {
  const text = fullText.trim()
  if (text.length <= maxChars) return text
  const len = text.length
  const slice = (start: number, size: number) =>
    text.slice(start, start + size)
  const chunk = Math.floor(maxChars / 4)
  const parts = [
    slice(0, chunk),
    slice(Math.floor(len * 0.35) - Math.floor(chunk / 2), chunk),
    slice(Math.floor(len * 0.65) - Math.floor(chunk / 2), chunk),
    slice(Math.max(0, len - chunk), chunk)
  ]
  return parts.map((p, i) => `【抽样${i + 1}】\n${p.trim()}`).join('\n\n')
}
```

- [ ] **Step 2: style-analysis-parser.ts**

```typescript
import type { StyleAnalysisResult } from './types'

export function extractStyleAnalysisFromReply(content: string): StyleAnalysisResult | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as StyleAnalysisResult
    if (!parsed.styleName || !parsed.promptTemplate) return null
    return parsed
  } catch {
    return null
  }
}

export function stripJsonBlockFromDisplay(content: string): string {
  return content.replace(/```json[\s\S]*?```/gi, '').trim()
}
```

- [ ] **Step 3: 验证构建**

Run: `npm run build`  
Expected: exit 0

---

## Task 5: 对话编排 assistant-chat.ts

**Files:**
- Create: `src/main/context/assistant/assistant-chat.ts`

- [ ] **Step 1: 实现核心函数**

```typescript
import type { WebContents } from 'electron'
import { modelService } from '../../model'
import { assistantRoleDAO, assistantConversationDAO, assistantMessageDAO, assistantDocumentDAO, writingStyleDAO } from '../../db'
import { extractStyleFingerprint } from '../style-fingerprint'
import { sampleDocumentText } from './document-sampling'
import { extractStyleAnalysisFromReply, stripJsonBlockFromDisplay } from './style-analysis-parser'

const activeChats = new Map<number, AbortController>()

export async function runAssistantChat(
  sender: WebContents,
  conversationId: number,
  userText: string,
  documentIds: number[] = []
): Promise<{ userMessageId: number; assistantMessageId: number }> {
  // 1. 取消同会话旧请求
  activeChats.get(conversationId)?.abort()
  const controller = new AbortController()
  activeChats.set(conversationId, controller)

  const conv = assistantConversationDAO.getById(conversationId)
  if (!conv) throw new Error('会话不存在')
  const role = assistantRoleDAO.getById(conv.role_id)
  if (!role) throw new Error('角色不存在')

  // 2. 保存 user 消息
  const userMessageId = assistantMessageDAO.create({
    conversation_id: conversationId,
    role: 'user',
    content: userText,
    message_type: documentIds.length ? 'attachment' : 'text',
    metadata_json: documentIds.length ? JSON.stringify({ documentIds }) : null
  })

  // 3. 组装附件 context
  let docContext = ''
  for (const docId of documentIds) {
    const doc = assistantDocumentDAO.getById(docId)
    if (!doc) continue
    const sample = sampleDocumentText(doc.content_text)
    docContext += `\n\n【文档：${doc.title}】\n${sample}\n【指纹】${doc.fingerprint_json ?? ''}`
  }

  const history = assistantMessageDAO.listByConversation(conversationId).slice(-20)
  const messages = history.map(m => ({ role: m.role, content: m.content }))

  const rules: string[] = role.analysis_rules_json ? JSON.parse(role.analysis_rules_json) : []
  const systemContent = [
    role.system_prompt,
    rules.length ? `\n【解析规则】\n${rules.map(r => `- ${r}`).join('\n')}` : ''
  ].join('\n')

  const assistantMessageId = assistantMessageDAO.create({
    conversation_id: conversationId,
    role: 'assistant',
    content: '',
    message_type: 'text',
    metadata_json: null
  })

  let fullContent = ''
  const emitDelta = (delta: string) => {
    fullContent += delta
    assistantMessageDAO.updateContent(assistantMessageId, fullContent)
    sender.send('assistant:delta', { conversationId, messageId: assistantMessageId, delta, content: fullContent })
  }

  try {
    const res = await modelService.chat({
      step: 'assistant_chat',
      systemPrompt: systemContent,
      userPrompt: `${userText}${docContext}`,
      messages: messages.filter(m => m.role !== 'system'),
      temperature: 0.7
    }, {
      webContents: sender,
      signal: controller.signal,
      onDelta: emitDelta,
      stream: true,
      suppressPhases: true
    })

    fullContent = res.content || fullContent
    const capabilities: string[] = role.capabilities_json ? JSON.parse(role.capabilities_json) : []
    let metadata: Record<string, unknown> | null = null
    let messageType: 'text' | 'tool_result' = 'text'
    let displayContent = fullContent

    if (capabilities.includes('style_export')) {
      const analysis = extractStyleAnalysisFromReply(fullContent)
      if (analysis) {
        metadata = { styleAnalysis: analysis }
        messageType = 'tool_result'
        displayContent = stripJsonBlockFromDisplay(fullContent)
      }
    }

    assistantMessageDAO.updateContent(assistantMessageId, displayContent, metadata ? JSON.stringify(metadata) : null)
    assistantConversationDAO.touch(conversationId)
    sender.send('assistant:chat-end', { conversationId, messageId: assistantMessageId, success: true })
    return { userMessageId, assistantMessageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '对话失败'
    sender.send('assistant:chat-end', { conversationId, messageId: assistantMessageId, success: false, error: msg })
    throw err
  } finally {
    activeChats.delete(conversationId)
  }
}

export function cancelAssistantChat(conversationId: number): boolean {
  const c = activeChats.get(conversationId)
  if (!c) return false
  c.abort()
  activeChats.delete(conversationId)
  return true
}

export function exportStyleFromAnalysis(
  analysis: StyleAnalysisResult,
  options?: { overwriteStyleId?: number; rename?: string }
): number {
  const name = options?.rename ?? analysis.styleName
  const sample_text = analysis.sampleExcerpts.join('\n\n').slice(0, 3000)
  if (options?.overwriteStyleId) {
    writingStyleDAO.update(options.overwriteStyleId, {
      name,
      description: analysis.description,
      sample_text,
      prompt_template: analysis.promptTemplate
    })
    const fp = extractStyleFingerprint(sample_text)
    writingStyleDAO.update(options.overwriteStyleId, { fingerprint_json: JSON.stringify(fp) })
    return options.overwriteStyleId
  }
  const existing = writingStyleDAO.getByName(name)
  if (existing) throw new Error(`文风名称「${name}」已存在`)
  const id = writingStyleDAO.create({
    name,
    description: analysis.description,
    sample_text,
    prompt_template: analysis.promptTemplate
  })
  const fp = extractStyleFingerprint(sample_text)
  writingStyleDAO.update(id, { fingerprint_json: JSON.stringify(fp) })
  return id
}
```

- [ ] **Step 2: 确认 modelService.chat 支持 `onDelta` + `signal`**

阅读 `src/main/model/model-service.ts` 的 `ChatOptions`；若缺少 `signal`，在 options 类型与 adapter 中传入 `AbortController.signal`（最小改动）。

- [ ] **Step 3: 验证构建**

Run: `npm run build`

---

## Task 6: IPC 注册

**Files:**
- Create: `src/main/ipc-assistant.ts`
- Modify: `src/main/ipc.ts`

- [ ] **Step 1: ipc-assistant.ts 实现全部 handler**

参照 spec §7，每个 handler 调用对应 DAO / `runAssistantChat` / `exportStyleFromAnalysis`。

`assistant:docUpload` 接受 `{ title?, fileName?, content }`，content 必填，上限 2_000_000 字符。

`assistant:convCreate` 接受 `{ roleId, title?, documentIds? }`。

- [ ] **Step 2: 在 ipc.ts 末尾注册**

```typescript
import { registerAssistantIpcHandlers } from './ipc-assistant'
// ...
registerAssistantIpcHandlers()
```

- [ ] **Step 3: 验证构建**

Run: `npm run build`

---

## Task 7: 路由与导航

**Files:**
- Modify: `src/renderer/src/router/index.ts`
- Modify: `src/renderer/src/components/AppLayout.vue`

- [ ] **Step 1: 添加路由**

```typescript
{
  path: '/assistant',
  name: 'assistant',
  component: () => import('../views/assistant/AssistantHub.vue')
}
```

- [ ] **Step 2: AppLayout navItems 增加**

```typescript
{ path: '/assistant', icon: 'robot', label: 'AI 助手', section: 'workspace' }
```

- [ ] **Step 3: 验证**

Run: `npm run dev`，点击「AI 助手」导航，路由应切换（页面可先空白）

---

## Task 8: useAssistantChat composable

**Files:**
- Create: `src/renderer/src/composables/useAssistantChat.ts`

- [ ] **Step 1: 实现状态与 IPC 封装**

```typescript
import { ref, onMounted, onUnmounted } from 'vue'
import type { StyleAnalysisResult } from '../../../main/context/assistant/types'

export function useAssistantChat(conversationId: Ref<number | null>) {
  const messages = ref<Array<{
    id: number
    role: string
    content: string
    message_type: string
    metadata_json: string | null
  }>>([])
  const streamingMessageId = ref<number | null>(null)
  const sending = ref(false)

  async function loadMessages() {
    if (!conversationId.value) { messages.value = []; return }
    messages.value = await window.anovel.invoke('assistant:messageList', conversationId.value) as typeof messages.value
  }

  function onDelta(payload: { conversationId: number; messageId: number; content: string }) {
    if (payload.conversationId !== conversationId.value) return
    const m = messages.value.find(x => x.id === payload.messageId)
    if (m) m.content = payload.content
    else messages.value.push({ id: payload.messageId, role: 'assistant', content: payload.content, message_type: 'text', metadata_json: null })
    streamingMessageId.value = payload.messageId
  }

  function onChatEnd(payload: { conversationId: number; success: boolean }) {
    if (payload.conversationId !== conversationId.value) return
    sending.value = false
    streamingMessageId.value = null
    void loadMessages()
  }

  onMounted(() => {
    window.anovel.on('assistant:delta', onDelta as (...args: unknown[]) => void)
    window.anovel.on('assistant:chat-end', onChatEnd as (...args: unknown[]) => void)
  })
  onUnmounted(() => {
    window.anovel.off('assistant:delta', onDelta as (...args: unknown[]) => void)
    window.anovel.off('assistant:chat-end', onChatEnd as (...args: unknown[]) => void)
  })

  async function send(text: string, documentIds: number[] = []) {
    if (!conversationId.value || !text.trim()) return
    sending.value = true
    await window.anovel.invoke('assistant:chat', conversationId.value, text.trim(), documentIds)
    await loadMessages()
  }

  async function cancel() {
    if (!conversationId.value) return
    await window.anovel.invoke('assistant:cancelChat', conversationId.value)
    sending.value = false
  }

  return { messages, sending, streamingMessageId, loadMessages, send, cancel }
}
```

- [ ] **Step 2: 验证构建**

Run: `npm run build`

---

## Task 9: AssistantHub 三栏布局

**Files:**
- Create: `src/renderer/src/views/assistant/AssistantHub.vue`
- Create: `src/renderer/src/views/assistant/AssistantConversationList.vue`

- [ ] **Step 1: AssistantHub.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import AssistantConversationList from './AssistantConversationList.vue'
import AssistantMessageList from './AssistantMessageList.vue'
import AssistantMessageInput from './AssistantMessageInput.vue'

const activeConversationId = ref<number | null>(null)
const attachedDocIds = ref<number[]>([])
</script>

<template>
  <div class="flex h-full min-h-[calc(100vh-0px)]">
    <aside class="w-72 border-r border-base-300 shrink-0 flex flex-col">
      <AssistantConversationList v-model="activeConversationId" />
    </aside>
    <section class="flex-1 flex flex-col min-w-0">
      <AssistantMessageList v-if="activeConversationId" :conversation-id="activeConversationId" />
      <div v-else class="flex-1 flex items-center justify-center text-base-content/40">
        选择或新建对话
      </div>
      <AssistantMessageInput
        v-if="activeConversationId"
        :conversation-id="activeConversationId"
        v-model:attached-doc-ids="attachedDocIds"
      />
    </section>
  </div>
</template>
```

- [ ] **Step 2: AssistantConversationList.vue**

- onMounted: `assistant:roleList`, `assistant:convList`
- 「新对话」按钮 → modal 选角色 → `assistant:convCreate` → 选中新建会话
- 列表项点击切换 `activeConversationId`
- 删除按钮 → confirm → `assistant:convDelete`

- [ ] **Step 3: 验证**

Run: `npm run dev`，能创建会话并看到空对话区

---

## Task 10: 消息列表与输入

**Files:**
- Create: `src/renderer/src/views/assistant/AssistantMessageList.vue`
- Create: `src/renderer/src/views/assistant/AssistantMessageInput.vue`

- [ ] **Step 1: MessageList**

- 使用 `useAssistantChat`
- user 消息右对齐 `chat chat-end`，assistant 左对齐 `chat chat-start`
- `message_type === 'tool_result'` 时渲染 `StyleAnalysisCard`（Task 11）
- assistant 流式时末尾显示 `loading dots`

- [ ] **Step 2: MessageInput**

- textarea + 发送按钮（Enter 发送，Shift+Enter 换行）
- 文件 input `accept=".txt,.md,text/plain,text/markdown"`
- 读取 file.text() → `assistant:docUpload` → 将返回 id 加入 `attachedDocIds`
- 显示已附文档 chip，可移除
- 发送时调用 `send(text, attachedDocIds)`，发送后清空附件
- sending 时显示「停止」→ `cancel()`

- [ ] **Step 3: 端到端验证**

Run: `npm run dev`  
1. 新建对话（文风分析师）  
2. 上传短 txt  
3. 发送「请分析这篇作品的文风」  
4. 应看到流式回复  

Expected: 模型已配置时返回 Markdown + 可选 JSON 块

---

## Task 11: StyleAnalysisCard 与导出

**Files:**
- Create: `src/renderer/src/views/assistant/cards/StyleAnalysisCard.vue`

- [ ] **Step 1: 卡片 UI**

- 从 `metadata_json` 解析 `styleAnalysis`
- 展示 styleName、description、dimensions 折叠面板
- `promptTemplate` 可编辑 textarea
- 按钮「保存到文风管理」→ `assistant:exportStyle`
- 若返回「名称已存在」错误 → modal 输入新名称重试

- [ ] **Step 2: IPC assistant:exportStyle**

```typescript
ipcMain.handle('assistant:exportStyle', (_e, analysis: StyleAnalysisResult, options?) =>
  exportStyleFromAnalysis(analysis, options))
```

- [ ] **Step 3: 验证**

保存后在 `/style` 页面能看到新文风，且「提取指纹」已有数据

---

## Task 12: 收尾与构建验证

**Files:**
- Modify: `src/renderer/src/main.ts`（若缺少 `faRobot` 已存在则跳过）

- [ ] **Step 1: 全量构建**

Run: `npm run build`  
Expected: exit 0

- [ ] **Step 2: 手动测试清单**

- [ ] 导航三入口：作品 / 文风 / AI 助手
- [ ] 新对话 + 选角色
- [ ] 上传 txt + 对话 + 流式
- [ ] 文风卡片保存 → 文风管理可见
- [ ] 自由创作顾问无 JSON 卡片
- [ ] 取消生成有效
- [ ] 助手 IPC 不传 workId

---

## Phase 2 任务概要（后续计划）

> 独立 PR / 计划：`2026-05-31-ai-assistant-phase2.md`

- [ ] `AssistantRoleManager.vue` — CRUD + 克隆
- [ ] `AssistantDocLibrary.vue` — 独立文档 Tab
- [ ] 内置「作品导读员」角色 + SummaryCard
- [ ] 会话重命名、搜索
- [ ] `assistant:roleClone` UI 入口

---

## Spec Coverage Self-Review

| Spec 要求 | 对应 Task |
|-----------|-----------|
| 顶级 `/assistant` 路由 | Task 7 |
| 外部上传为主 | Task 6 docUpload, Task 10 输入 |
| 无 workId 联动 | Task 5/6 全程无 workId |
| IM 多轮 + 流式 | Task 5, 8, 10 |
| 角色管理（内置 seed） | Task 3；Phase 2 完整 CRUD |
| 文风导出 | Task 5 exportStyle, Task 11 |
| 独立流式事件 | Task 5 `assistant:delta` |
| 长文抽样 | Task 4 |
| 同名文风冲突 | Task 5 throw + Task 11 modal |

**无 TBD / 占位符。**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-31-ai-assistant.md`.

**Two execution options:**

1. **Subagent-Driven（推荐）** — 按 Task 1→12 逐 task 派生子 agent，每 task 后 review  
2. **Inline Execution** — 本会话连续实现，每 2–3 task 汇报 checkpoint  

**Which approach?**
