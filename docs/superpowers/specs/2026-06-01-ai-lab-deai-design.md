# AI 实验室 — 去AI味功能设计文档

## 概述

在侧边栏新增「AI 实验室」入口，第一版聚焦「去AI味」功能：用户提供文章/内容，通过 AI 改写去除 AI 痕迹，使文本更像人类自然书写。

## 需求摘要

- **输入方式**：粘贴文本 + 文件上传（txt/md/docx）
- **结果展示**：默认左右对比（原文 vs 改写），可切换纯结果视图
- **控制粒度**：改写程度滑杆（轻度/中度/深度）+ 目标风格选择
- **历史记录**：每次处理保存记录，可回顾
- **范围**：第一版仅含去AI味功能

## 架构决策

采用**独立模块 + 专用 IPC 命名空间**方案：
- 前端：`views/lab/` 独立视图模块
- 后端：`ipc-lab.ts` + `context/lab/` 专用命名空间
- 数据：新建 `lab_task` 表
- 流式输出：`lab:delta` / `lab:run-end` 事件

选择理由：去AI味是工具型功能（输入→配置→处理→对比），不适合对话式交互；独立模块与项目现有架构一致（每个顶级导航对应独立视图）；未来可在 AI 实验室下扩展更多实验工具。

---

## 页面布局

```
┌─────────────────────────────────────────────────────┐
│ 页头：AI 实验室 > 去AI味                    [历史记录]  │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─── 输入区 ─────────────────────────────────────┐ │
│  │  [文本输入框]                     [上传文件▲]   │ │
│  │                                                │ │
│  │  改写程度: ○轻度  ●中度  ○深度                  │ │
│  │  目标风格: [下拉选择]                           │ │
│  │                          [开始去AI味 ▶]         │ │
│  └────────────────────────────────────────────────┘ │
│                                                     │
│  ┌─── 结果区（处理后出现）────────────────────────┐ │
│  │  [对比视图 | 纯结果]                 [复制][导出]│ │
│  │  ┌──── 原文 ────┐  ┌── 改写结果 ──┐            │ │
│  │  │              │  │              │            │ │
│  │  │              │  │  (流式输出)   │            │ │
│  │  │              │  │              │            │ │
│  │  └──────────────┘  └──────────────┘            │ │
│  └────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 交互流程

1. 用户粘贴文本或上传文件 → 文本填充到输入框
2. 选择改写程度（轻度/中度/深度）和目标风格
3. 点击「开始去AI味」→ 结果区出现，右侧流式输出改写结果
4. 完成后可切换「对比视图」/「纯结果」，可复制或导出
5. 每次处理自动保存到历史记录

### 目标风格预设

| 风格 ID | 显示名 | 说明 |
|---------|--------|------|
| `natural` | 自然口语 | 像日常说话一样自然 |
| `literary` | 文学叙事 | 文学性描写，有质感 |
| `news` | 新闻报道 | 简洁客观的新闻体 |
| `academic` | 学术论文 | 严谨的学术表达 |
| `custom` | 自定义 | 用户输入自定义风格描述 |

### 历史记录

从右侧滑出的抽屉面板：
- 列表项：创建时间、原文摘要（前50字）、改写程度 badge、目标风格 badge
- 点击记录 → 加载到主面板展示对比
- 支持删除单条记录（确认弹窗）
- 空状态提示

---

## 数据库

### `lab_task` 表

```sql
CREATE TABLE lab_task (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  original_text TEXT    NOT NULL,
  result_text   TEXT,
  intensity     TEXT    NOT NULL DEFAULT 'medium',  -- light / medium / deep
  target_style  TEXT    NOT NULL DEFAULT 'natural',  -- natural / literary / news / academic / custom
  custom_style  TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',  -- pending / running / done / error
  error_message TEXT,
  source_file   TEXT,
  char_count    INTEGER NOT NULL DEFAULT 0,
  create_time   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  update_time   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
```

---

## IPC 通道

| 通道 | 类型 | 参数 | 返回 | 说明 |
|------|------|------|------|------|
| `lab:taskCreate` | handle | `{ originalText, intensity, targetStyle, customStyle?, sourceFile? }` | `LabTask` | 创建任务记录 |
| `lab:taskList` | handle | 无 | `LabTask[]` | 获取历史列表（按时间倒序） |
| `lab:taskGet` | handle | `id: number` | `LabTask \| undefined` | 获取单条记录 |
| `lab:taskDelete` | handle | `id: number` | `boolean` | 删除记录 |
| `lab:run` | handle | `id: number` | `void` | 执行去AI味（触发流式 LLM） |
| `lab:cancelRun` | handle | `id: number` | `void` | 取消运行中的任务 |
| `lab:parseFile` | handle | `{ fileName, base64 }` | `string` | 解析上传文件为纯文本（docx 用 docx-extract，txt/md 直接解码） |
| `lab:delta` | event | `{ taskId, content }` | — | 流式增量推送 |
| `lab:run-end` | event | `{ taskId, success, error? }` | — | 任务完成/失败 |

---

## 后端逻辑

### Prompt 策略

位于 `src/main/context/lab/deai-prompts.ts`：

**改写程度差异**：
- **轻度 (light)**：只修改明显的 AI 模式化表达（"首先...其次...最后"、"值得注意的是"、"总之"等固定套路），保持原文结构和主要用词
- **中度 (medium)**：重组句式、替换常见 AI 用词、调整节奏感、去除过度总结和概括，保持内容完整
- **深度 (deep)**：大幅改写，打散重组段落结构，注入目标风格特色，允许增减细节以增强真实感

**目标风格差异**：
- 每种风格有对应的 prompt 片段描述目标文风特征
- `custom` 类型直接使用用户输入的风格描述

### 核心流程（`deai-rewrite.ts`）

1. 从 `lab_task` 读取任务记录
2. 更新 status → `running`
3. 根据 intensity + target_style 组装 system prompt
4. 调用 `model-service.ts` 统一 LLM 接口，流式模式
5. 每收到 delta → 通过 `webContents.send('lab:delta', ...)` 推送
6. 完成后更新 `lab_task.result_text` 和 `status`，发送 `lab:run-end`
7. 取消时通过 `ai-session-manager` 中止

---

## 前端文件结构

```
src/renderer/src/views/lab/
├── AiLaboratory.vue              # 主页面（路由入口）
├── DeaiInputPanel.vue            # 输入区面板
├── DeaiResultPanel.vue           # 结果对比/纯结果面板
└── DeaiHistoryDrawer.vue         # 历史记录抽屉

src/renderer/src/composables/
└── useDeaiTask.ts                # 前端状态管理 composable
```

### 组件职责

**`AiLaboratory.vue`**：
- 页头标题（PanelTitle 组件）+ 历史记录按钮
- 管理当前任务状态（`useDeaiTask` composable）
- 组合 DeaiInputPanel 和 DeaiResultPanel
- 控制 DeaiHistoryDrawer 显隐

**`DeaiInputPanel.vue`**：
- textarea 输入框（支持拖拽粘贴）
- 文件上传按钮（txt/md/docx）：前端读取文件为 base64，通过 `lab:parseFile` IPC 发送到 main 进程解析（docx 使用 `docx-extract.ts`，txt/md 直接 UTF-8 解码），返回纯文本填入输入框
- 改写程度：3 个 radio button（轻度/中度/深度），默认中度
- 目标风格：select 下拉，选 custom 时展开自定义输入框
- 「开始去AI味」主按钮 / 处理中显示「取消」
- 字数统计

**`DeaiResultPanel.vue`**：
- 视图切换 tab：「对比视图」/「纯结果」
- 对比视图：左右两栏 flex，左原文右改写结果（流式渲染，使用 MarkdownContent 组件）
- 纯结果视图：全宽改写结果
- 操作按钮：复制到剪贴板、导出为 txt
- 处理中显示 spinner + 实时字数

**`DeaiHistoryDrawer.vue`**：
- 右侧滑出抽屉，transition 动画
- 每条记录：时间、原文摘要50字、intensity badge、style badge
- 点击 → emit 事件加载到主面板
- 删除按钮 + 确认弹窗

### `useDeaiTask.ts` composable

```typescript
interface DeaiTaskState {
  originalText: string
  resultText: string
  intensity: 'light' | 'medium' | 'deep'
  targetStyle: 'natural' | 'literary' | 'news' | 'academic' | 'custom'
  customStyle: string
  status: 'idle' | 'running' | 'done' | 'error'
  errorMessage: string
  currentTaskId: number | null
}

// 方法
run(): Promise<void>        // 创建任务 + 触发执行
cancel(): Promise<void>     // 取消当前任务
loadFromHistory(id: number): Promise<void>
reset(): void               // 重置到初始状态

// 生命周期
onMounted: 注册 lab:delta / lab:run-end 监听
onUnmounted: 移除监听
```

---

## 集成点

| 文件 | 变更 |
|------|------|
| `src/renderer/src/components/AppLayout.vue` | navItems 新增 `{ path: '/ai-lab', icon: 'flask', label: 'AI 实验室', section: 'workspace' }` |
| `src/renderer/src/router/index.ts` | 新增 `/ai-lab` 路由 |
| `src/renderer/src/main.ts` | 导入并注册 `faFlask` 图标 |
| `src/main/index.ts` | 调用 `registerLabIpcHandlers()` |
| `src/main/db/index.ts` | 创建 `lab_task` 表 + 导出 `labTaskDAO` |
| `src/preload/index.ts` | 无需修改（已有通用 invoke/on/off） |

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/shared/lab-types.ts` | 共享类型（LabTask, LabTaskCreateInput 等） |
| `src/main/ipc-lab.ts` | IPC handler 注册 |
| `src/main/db/lab-task-dao.ts` | lab_task DAO |
| `src/main/context/lab/deai-rewrite.ts` | 去AI味核心逻辑 |
| `src/main/context/lab/deai-prompts.ts` | prompt 模板 |
| `src/renderer/src/views/lab/AiLaboratory.vue` | 主页面 |
| `src/renderer/src/views/lab/DeaiInputPanel.vue` | 输入面板 |
| `src/renderer/src/views/lab/DeaiResultPanel.vue` | 结果面板 |
| `src/renderer/src/views/lab/DeaiHistoryDrawer.vue` | 历史抽屉 |
| `src/renderer/src/composables/useDeaiTask.ts` | composable |

---

## 错误处理

- **LLM 调用失败**：结果区显示错误信息 + 重试按钮，status 更新为 error
- **文件解析失败**：toast 提示，输入框保持空白
- **文本过长**：前端限制 5 万字，超出时提示分段处理
- **取消操作**：立即中止流式输出，已生成内容保留，status 置为 done

## UI 风格

遵循现有 DaisyUI 组件体系：btn、textarea、select、card、badge、menu 等。
