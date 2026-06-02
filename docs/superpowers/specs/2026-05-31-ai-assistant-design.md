# AI 助手模块设计规格

**日期：** 2026-05-31  
**状态：** 已评审（用户确认）  
**版本：** v1.0

---

## 1. 背景与目标

ANovel 已有作品创作流（Editor）与文风管理（`/style`），但缺少一个**独立于作品**的通用 AI 对话入口。用户希望：

1. **以外部上传作品为主**，分析第三方或历史 txt/md，不读取 ANovel 作品 DB；
2. **顶级导航入口**，与「作品管理」「文风管理」同级；
3. **角色管理**：不同角色承担不同能力（文风分析、导读、自由顾问等）；
4. **IM 式即时对话**：多轮追问、流式回复；
5. **文风输出**：分析结果可一键写入文风管理，供后续作品绑定使用（助手本身不绑定作品）。

**非目标（首期不做）：**

- 与 Editor / `workId` 联动；
- 从 ANovel 章节导入正文；
- docx/epub 解析（二期）；
- 云端同步或多设备会话。

---

## 2. 产品定位

```
工作空间
├── 作品管理      /
├── 文风管理      /style
├── AI 助手       /assistant   ← 本模块
系统
└── 系统设置      /setting
```

与现有 `AiActivityPanel`（右下角生成任务浮窗）分工：

| 组件 | 场景 |
|------|------|
| `AiActivityPanel` | Editor 内正文/大纲生成时的后台任务与流式状态 |
| `AI 助手` | 独立页面、持久会话、角色化、外部文档分析 |

---

## 3. 用户故事

### US-1 上传并分析文风

> 作为作者，我上传一本旧作 txt，选择「文风分析师」角色，在对话中说「请分析文风」，收到结构化报告后点击「保存到文风管理」。

**验收：**

- 支持 `.txt` / `.md` 上传与粘贴；
- 回复含可编辑的 Prompt 模板与样例段落；
- 保存后可在 `/style` 看到新文风，且已提取 `fingerprint_json`。

### US-2 多轮追问

> 作为作者，我觉得对话密度分析偏低，在 IM 中追问「请提高对话占比描述并重写 Prompt」，助手更新卡片内容。

**验收：**

- 会话保留历史；
- 新回复可覆盖/更新同一会话内的文风卡片；
- 流式显示 assistant 消息。

### US-3 角色切换

> 作为作者，我想用「自由创作顾问」讨论写作技巧，与文风分析分开。

**验收：**

- 新建会话时选择角色；
- 不同角色 system prompt 与输出能力不同；
- 换角色需新会话（不在中途切换）。

### US-4 自定义角色（Phase 2）

> 作为作者，我克隆「文风分析师」，增加「重点分析幽默与吐槽」规则，保存为自定义角色。

**验收：**

- 内置角色不可删除，可克隆；
- 自定义角色可 CRUD。

---

## 4. 信息架构

### 4.1 页面布局（三栏 IM）

```
┌────────────┬──────────────────┬─────────────────────────────┐
│ AppLayout  │  会话列表         │  对话区                      │
│ 左导航     │  + 新对话         │  消息气泡（user/assistant）   │
│            │  按角色图标分组     │  结构化卡片（tool_result）    │
│            │  [管理角色]       │  输入框 + 附件 + 发送         │
└────────────┴──────────────────┴─────────────────────────────┘
```

可选 Tab：**对话** | **文档库**（Phase 2 独立 Tab；Phase 1 可在输入区上传）。

### 4.2 角色（Assistant Role）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | number | 主键 |
| `name` | string | 显示名 |
| `description` | string | 一句话说明 |
| `icon` | string | FontAwesome 图标名，如 `palette` |
| `system_prompt` | string | 角色人设与行为边界 |
| `analysis_rules_json` | string | 解析规则数组 JSON |
| `capabilities_json` | string | 能力标签，如 `["style_export"]` |
| `is_builtin` | 0/1 | 内置不可删 |
| `create_time` / `update_time` | datetime | |

**内置角色（首期 seed）：**

| 名称 | icon | capabilities | 说明 |
|------|------|--------------|------|
| 文风分析师 | palette | style_export | 输出文风 JSON 卡片 + 保存文风 |
| 自由创作顾问 | feather-alt | — | 纯 Markdown 对话 |

**Phase 2 增加：**

| 名称 | icon | capabilities |
|------|------|--------------|
| 作品导读员 | book-open | summary_card |

### 4.3 外部文档（Assistant Document）

| 字段 | 说明 |
|------|------|
| `id`, `title`, `file_name` | 文档标识 |
| `content_text` | 全文正文 |
| `char_count` | 字数 |
| `fingerprint_json` | 上传时用 `extractStyleFingerprint` 预计算 |
| `create_time` | |

**约束：** 无 `work_id`；单文件建议上限 2MB（可配置）；超长文仅存全文，送 LLM 时用抽样。

### 4.4 会话与消息

**assistant_conversations：**

- `id`, `role_id`, `title`, `document_ids_json`, `create_time`, `update_time`
- 无 `work_id`

**assistant_messages：**

- `id`, `conversation_id`, `role`（user | assistant | system）
- `content`, `message_type`（text | attachment | tool_result）
- `metadata_json`（附件 id 列表、结构化 StyleAnalysisResult 等）
- `create_time`

---

## 5. 文风分析结构化输出

AI（文风分析师）在回复末尾附加 JSON 块（或单独 tool_result 消息），schema：

```typescript
interface StyleAnalysisResult {
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
```

**保存到文风管理：**

1. `sample_text` = `sampleExcerpts.join('\n\n').slice(0, 3000)`
2. `style:create({ name, description, sample_text, prompt_template })`
3. `fingerprint:saveToStyle(styleId, sample_text)`（复用现有 IPC）
4. 不调用 `style:setWorkStyle`

**同名冲突：** 弹窗让用户选择「重命名 / 覆盖更新 / 取消」。

---

## 6. 对话与 Prompt 组装

### 6.1 请求路径

`assistant:chat(conversationId, userMessage, attachmentDocumentIds?)`

1. 加载会话、角色、最近 N 条消息（默认 20 条或 token 预算内截断）；
2. 若有附件，对每个文档调用 `sampleDocumentText(fullText, 4000)` 取抽样；
3. 全文 `fingerprint_json` 作为辅助数值注入 user context；
4. 调用 `modelService.chat`，`step: 'assistant_chat'`，启用 streaming；
5. 流式 delta 通过 **`assistant:delta`** 事件推送（独立于 `ai:delta`，避免与 Editor 浮窗冲突）；
6. 完成后解析 JSON → 若有 `style_export` 能力且解析成功，写入 `tool_result` 类型消息。

### 6.2 System Prompt 模板（文风分析师）

```
你是 ANovel 的文风分析师。用户会提供外部作品节选与本地文风指纹数据。
请按用户规则分析，用中文回复。
若用户请求文风归纳或保存准备，在回复末尾输出 ```json ... ``` 块，符合 StyleAnalysisResult schema。
不要编造未在文本中出现的具体情节细节。
```

### 6.3 长文抽样策略

从全文中取 4 段，每段最多 800 字：

- 开头 15%
- 约 35% 位置
- 约 65% 位置
- 结尾 15%

不足 4000 字则全文送入。

---

## 7. IPC 接口

| Channel | 说明 |
|---------|------|
| `assistant:roleList` | 列表 |
| `assistant:roleGet` | 单条 |
| `assistant:roleCreate` | 自定义角色 |
| `assistant:roleUpdate` | 更新（内置仅允许改 rules 的克隆版） |
| `assistant:roleDelete` | 删除（内置禁止） |
| `assistant:roleClone` | 克隆内置/自定义 |
| `assistant:docUpload` | `{ title?, fileName, content }` → id |
| `assistant:docList` / `docGet` / `docDelete` | 文档库 |
| `assistant:convList` / `convCreate` / `convUpdate` / `convDelete` | 会话 |
| `assistant:messageList` | 按 conversationId |
| `assistant:chat` | 发消息 + 流式（返回 messageId） |
| `assistant:cancelChat` | 取消当前会话生成 |
| `assistant:exportStyle` | 从 metadata 或参数创建文风 |

**事件（main → renderer）：**

- `assistant:delta` — `{ conversationId, messageId, delta, content }`
- `assistant:chat-end` — `{ conversationId, messageId, success, error? }`

---

## 8. 前端组件

| 文件 | 职责 |
|------|------|
| `views/assistant/AssistantHub.vue` | 三栏容器、Tab 切换 |
| `AssistantConversationList.vue` | 会话 CRUD、新对话选角色 |
| `AssistantMessageList.vue` | 消息渲染、流式、卡片 |
| `AssistantMessageInput.vue` | 输入、上传、发送、取消 |
| `AssistantRoleManager.vue` | 角色 CRUD modal |
| `AssistantDocLibrary.vue` | 文档库（Phase 2） |
| `cards/StyleAnalysisCard.vue` | 文风卡片 + 保存按钮 |
| `composables/useAssistantChat.ts` | IPC + 事件订阅 |

**路由：** `/assistant` → `AssistantHub.vue`  
**导航：** `AppLayout.vue` 增加 `{ path: '/assistant', icon: 'robot', label: 'AI 助手' }`

---

## 9. 分阶段交付

### Phase 1 — MVP（本计划主范围）

- 数据库表 + 内置 2 角色 seed
- 文档上传（txt/md/粘贴）
- IM 对话 + 独立流式事件
- 文风分析师 + StyleAnalysisCard + exportStyle
- 会话列表与基本 CRUD

### Phase 2

- 角色 CRUD + 克隆
- 文档库 Tab、@引用
- 作品导读员角色

### Phase 3

- docx、消息编辑重发、分析历史对比

---

## 10. 风险与约束

| 风险 | 缓解 |
|------|------|
| 与 `AiActivityPanel` 流式事件冲突 | 使用独立 `assistant:*` 事件通道 |
| 超长文档超 context | 抽样 + 本地 fingerprint 全文统计 |
| JSON 解析失败 | 重试一次；UI 仍显示 Markdown 正文，卡片可选手动触发「尝试提取」 |
| 隐私 | 文案注明数据本地存储，仅用户配置的模型 API 出站 |
| `writing_styles.name` UNIQUE | exportStyle 冲突处理 UI |

---

## 11. 已确认决策

| 决策 | 结论 |
|------|------|
| 解析对象 | **以外部上传为主**，不联动作品 |
| 入口位置 | **与文风/作品同级**，非 Editor Sidebar |
| 交互形态 | **IM 多轮对话** |
| 能力扩展 | **角色管理**驱动 |
| 会话换附件 | 可追加；换主分析文档时提示新开会话 |
| Phase 1 角色 | 文风分析师 + 自由创作顾问 |

---

## 12. 参考现有代码

- 文风 CRUD：`src/main/db/dao/style-dao.ts`，IPC `style:create`
- 指纹：`src/main/context/style-fingerprint.ts`，IPC `fingerprint:saveToStyle`
- 流式会话：`src/main/ai/ai-session-manager.ts`（参考模式，独立实现 assistant 流）
- 模型调用：`src/main/model/model-service.ts`，`model:chat`
- 顶栏导航：`src/renderer/src/components/AppLayout.vue`
- 上传参考：`WorkList.vue` importWorkFromFile 模式
