# AIGC 实验室：朱雀检测对齐进度

更新时间：2026-07-17（Asia/Shanghai）

## 当前状态

本轮已完成第一阶段实现和部分本机模型校准，代码可以构建，纯逻辑回归测试通过。完整的 12 组朱雀标注样本尚未全部复测；为避免离开后继续占用 GPU/内存，校准进程已经停止。

当前 `main` 的 `8488a8e` 已包含第一阶段基础实现：

- 朱雀方向的单向 token 可预测性评分：高 PPL、低 Top-5 命中率不再反向判成 AI。
- 约 240 字的自然边界分段，且不丢短句、短对话、空行或标点。
- 电影镜头链、书面连接词、模板情感句、总结收束句的分层权重。
- 首段位置加权、连续 AI 段与交替段的区别判定。
- 移除原先会把所有段落一起推高的全文一致性加分。

本次待提交的增量包含：

- 增加修仙等领域词、DeepSeek 低频具象风格词的降风险校准。
- 增加文档中位数、双簇混合、孤立人工锚点判定，用于区分 A1/H1/Q6/K4。
- 把整文推理批量从 256 降到 32。实测 256 个 token 的全词表概率会突破 4GB V8 堆并崩溃。
- AIGC 实验室按朱雀口径要求至少 350 个非空白字符，并更新界面说明。
- 增加纯逻辑回归测试与本机模型校准脚本。

## 已验证结果

纯逻辑测试：

```bash
rtk ./node_modules/.bin/jiti scripts/test-zhuque-alignment.ts
```

结果：`朱雀对齐检测回归测试通过`。

生产构建：

```bash
rtk npm run build
```

结果：通过。只有现有的 Vite 动静态重复导入提示，无构建错误。

本机 Qwen3.5-0.8B 实测（新分类逻辑）：

| 样本 | 朱雀结果 | 当前检测 | 状态 |
|---|---:|---:|---|
| A1 人工原文 | 人工 100% | 人工 100% | 已对齐 |
| A2 纯 AI | AI 100% | AI 100% | 已对齐 |
| F8 均匀句长 | 人工 100% | 人工 100% | 已对齐，确认句长不加罚 |
| F4 连接词注入 | 人工 61% | 人工 23.77%、疑似 76.23% | 仍偏严，需要降低连接词段扩散 |
| F6 镜头链注入 | 文档只记录人工 19% | 当前人工 0%、AI 100% | 人工方向接近但过严；原实验未记录疑似/AI拆分，不能用假定值校准 |

此前同一批原始指标还验证了：

- K4 交替混合可达到人工约 30.43%、疑似约 69.57%，接近朱雀 28.09% / 71.91%。
- WS4 相邻词交换得到人工 100%，与朱雀一致。
- 旧阈值会把 A1 人工原文判成疑似 100%，已由文档中位数校准修正。

## 尚未完成

1. 继续复测 H1、G1、G3、M4、Q6、K4、WS4；重点确认领域词和 DeepSeek 风格降风险是否过度。
2. 把 F4 从人工 23.77% 调回接近 61%，同时保持 A1/F8 为人工 100%。
3. 查找 F6 原始完整三分类记录；在只有“人工 19%”时，不应假定另外 81% 全是疑似。
4. 校准本地 API 的 logprobs 退化回退路径。当前无有效 logprobs 时仍只能给低置信度启发式结果。
5. 完成全部样本后重新执行纯逻辑测试和生产构建。

## 回家后继续命令

校准脚本需要先打包为临时 ESM 文件，避免 `jiti` 与 `node-llama-cpp` 的顶层 await 冲突：

```bash
rtk ./node_modules/.bin/esbuild scripts/calibrate-zhuque-alignment.ts --bundle --platform=node --format=esm --external:node-llama-cpp --outfile=node_modules/.cache/anovel-calibrate-zhuque.mjs
rtk node node_modules/.cache/anovel-calibrate-zhuque.mjs
```

校准指标会写入 `/tmp/anovel-zhuque-calibration-cache.json`，中途中止后再次运行可从已完成样本继续。若代码中的分段或模型指标计算方式发生变化，应先删除该缓存再重跑。

最后验证：

```bash
rtk ./node_modules/.bin/jiti scripts/test-zhuque-alignment.ts
rtk npm run build
```

## 相关文件

- `src/main/perplexity/zhuque-alignment.ts`
- `src/main/perplexity/perplexity-service.ts`
- `src/main/perplexity/perplexity-worker.ts`
- `src/main/perplexity/constants.ts`
- `src/main/context/lab/aigc-detect.ts`
- `src/renderer/src/views/lab/AigcDetectInputPanel.vue`
- `src/renderer/src/views/lab/AigcDetectResultPanel.vue`
- `scripts/test-zhuque-alignment.ts`
- `scripts/calibrate-zhuque-alignment.ts`

