# 连续正文生成微调方案

## 目标

微调的目标不是把一段 AI 正文“改得像人工”，而是让模型从第一次选择词语和叙事内容时，就沿着合法授权的人类作者语料形成的注意力、叙述距离、信息释放和角色声线继续写作。

朱雀等外部检测器只能作为盲测观测指标，不能作为训练损失，也不能保证稳定得到某个标签。

## 已落地能力

- `scripts/gen-sft-dataset.mjs`：从连续章节构造“前文 → 后续正文”SFT 数据。
- 先按章节切分 train/validation/test，再在集合内部采样，避免相邻正文随机泄漏。
- 清理作者说明、网址、求票、目录跳转等非正文行。
- 训练目标精确去重。
- 80 字跨集合重合硬门禁；发现重合立即终止，不生成可上传数据。
- 输出原始语料 SHA-256、章节数、切分策略和样本数清单。
- 应用已有自定义 OpenAI 兼容提供商和 `body_generation` 步骤模型槽位，可直接路由到训练后的模型端点。

## 语料要求

只使用明确拥有训练、改编和模型使用权利的文本。每部作品应保留来源、权利证明、授权范围和有效期；数据清单中的哈希用于确认训练时实际使用的版本。

禁止把以下内容混入正文：

- 网站广告、下载链接、作者说明、求票信息；
- 目录、章节导航、重复章节；
- 未取得训练授权的网络小说；
- 由通用模型重新生成后冒充的“人工 target”。

## 构建数据

```bash
node scripts/gen-sft-dataset.mjs \
  --source-dir corpus/authorized \
  --out-dir datasets/continuation \
  --context-chars 1800 \
  --target-chars 650 \
  --stride-chars 520 \
  --leakage-chars 80
```

输出：

```text
datasets/continuation/
├── train.jsonl
├── validation.jsonl
├── test.jsonl
└── manifest.json
```

每条数据采用标准 messages 格式：

```json
{
  "messages": [
    { "role": "system", "content": "你正在续写一部小说……" },
    { "role": "user", "content": "【连续前文】\n……" },
    { "role": "assistant", "content": "真实后续正文……" }
  ]
}
```

不得把测试集重新加入训练，也不得根据测试集朱雀分数反复修改数据后继续宣称它是盲测集。需要继续迭代时，应新增验证集；最终测试集保持封存。

## 训练顺序

1. 使用 SFT 学习连续正文选择，不训练“AI文本 → 人工改写”。
2. 在 validation 集上选择轮次、学习率和 LoRA rank。
3. 如需偏好训练，偏好必须来自人工编辑判断；朱雀分数不能直接充当 chosen/rejected 标签。
4. 训练完成后只运行一次封存 test 集，记录模型版本、参数和输出。

推荐从小规模 LoRA 开始。训练平台和基础模型取决于授权、费用和部署环境，仓库不写死某家平台或模型名称。

## 接入正文生成

训练平台需暴露 OpenAI 兼容接口。接入步骤：

1. 在“设置 → AI 服务”新增自定义提供商，填写训练模型的 API Base、模型名和密钥。
2. 在“步骤模型分配 → 正文生成”选择该提供商和微调模型。
3. 在作品正文模型槽位选择同一模型。运行时 `body_generation` 会采纳作品正文模型槽位；诊断和修复仍使用各自步骤模型，不会误路由到正文模型。
4. 保留目标范文用于作品级上下文，但不要再添加机械“人味”规则。

## 验收

先对封存测试集生成候选：

```bash
FINETUNE_API_KEY=... npm run evaluate:finetuned-continuation -- \
  --input datasets/continuation/test.jsonl \
  --output datasets/continuation/test-output.jsonl \
  --api-base https://your-endpoint.example/v1 \
  --model your-finetuned-model \
  --api-key-env FINETUNE_API_KEY
```

脚本记录生成长度、与真实后续的 bigram 重合和最长连续重合，并预留人工盲评、外部检测字段。它不会自动把朱雀结果回灌成训练标签。

必须同时记录：

- 未参与训练的连续章节续写质量；
- 人工编辑对角色声线、叙述距离、注意力和事件连续性的盲评；
- 生成结果与所有训练 target 的最长重合；
- 本地多维检测六项诊断；
- 朱雀等外部检测结果及检测日期、文本长度、模型版本；
- 同一提示至少三次生成的波动，避免只挑一次最好结果。

上线条件不是“人工100%”，而是未见章节质量通过、无训练泄漏、作者确认可用，并且外部检测结果不再系统性地与人工判断相反。
