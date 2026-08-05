# Narrative V2 CLI

Narrative V2 是与旧 UI、旧工作流和旧模型选择器隔离的自动化小说后端。它使用独立 SQLite 文件；每个执行运行冻结唯一的 provider、协议、端点、模型与提示协议版本。

## 自动全书生成

桌面端进入“小说管理 V2”后，会直接使用“系统设置 → AI 服务”中的全局默认模型；V2 不提供单独模型选择。新建小说后填写故事创意、目标章节数与单章字数范围，系统会生成紧凑的全书蓝图，再在每一章提交后根据权威状态自动规划下一章契约、生成正文、提取证据、执行六项文学门并原子提交。运行启动时会将当时的全局模型配置冻结进运行合同，之后修改全局设置不会影响已启动的运行。

这不是一次性要求模型输出全部章节大纲，因此不会因长篇章节数而耗尽单次输出预算。运行、蓝图、模型调用和每个子章节运行都保存于独立 V2 SQLite；中断后可在同一页面恢复或取消。

## 配置

创建一个仅供本机使用的 JSON 文件，不要提交 API Key：

```json
{
  "databasePath": "narrative-v2.sqlite",
  "model": {
    "provider": "your-openai-compatible-provider",
    "providerProtocol": "openai",
    "apiBase": "https://example.com/v1",
    "apiKey": "replace-with-your-secret",
    "model": "your-fixed-model",
    "timeoutMs": 240000
  },
  "automation": {
    "maxRepairs": 2,
    "maxStepAttempts": 2,
    "editorialPolicyVersion": 1
  }
}
```

`providerProtocol` 必须为 `openai`。没有默认端点、默认模型或备用模型；缺少任何字段即拒绝启动。

## 命令

```bash
node scripts/narrative-v2.mjs init --config /absolute/v2.json --novel-id 1 --title "小说名"
node scripts/narrative-v2.mjs intent --config /absolute/v2.json --file /absolute/chapter-1-intent.json
node scripts/narrative-v2.mjs run --config /absolute/v2.json --run-id run-1 --novel-id 1 --intent-id chapter-1
node scripts/narrative-v2.mjs status --config /absolute/v2.json --run-id run-1
node scripts/narrative-v2.mjs export --config /absolute/v2.json --novel-id 1 --output /absolute/publication.md
```

章节契约只允许建立下一章，且必须基于当前事件流版本。`run` 按“正文、状态补丁、六个文学门、必要修订、原子提交”执行。模型返回的证据只能是唯一原文引文，偏移与哈希在本地计算。

导出会重新播放事件流、校验 SQLite 和外键完整性，并要求已提交章节从第一章起连续；任何失败都不会产生发布稿。
