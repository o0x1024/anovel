# AIGC 实验室：朱雀检测对齐进度

更新时间：2026-07-17（Asia/Shanghai）

## 当前状态

本轮已完成 12 组朱雀标注样本的本机 Qwen3.5-0.8B 全量校准。纯逻辑回归测试与生产构建均通过，已知标注字段平均误差从 15.9% 降至 2.0%。

提交 `8488a8e` 包含第一阶段基础实现：

- 朱雀方向的单向 token 可预测性评分：高 PPL、低 Top-5 命中率不再反向判成 AI。
- 约 240 字的自然边界分段，且不丢短句、短对话、空行或标点。
- 电影镜头链、书面连接词、模板情感句、总结收束句的分层权重。
- 首段位置加权、连续 AI 段与交替段的区别判定。
- 移除原先会把所有段落一起推高的全文一致性加分。

后续校准增量包含：

- 增加修仙等领域词、DeepSeek 低频具象风格词的降风险校准。
- 增加文档中位数、双簇混合、孤立人工锚点判定，用于区分 A1/H1/Q6/K4。
- 把整文推理批量从 256 降到 32。实测 256 个 token 的全词表概率会突破 4GB V8 堆并崩溃。
- AIGC 实验室按朱雀口径要求至少 350 个非空白字符，并更新界面说明。
- 增加纯逻辑回归测试与本机模型校准脚本。

## 已验证结果

纯逻辑测试：

```bash
rtk npm run test:zhuque-alignment
```

结果：`朱雀对齐检测回归测试通过`。

生产构建：

```bash
rtk npm run build
```

结果：通过。只有现有的 Vite 动静态重复导入提示，无构建错误。

## 最终校准结果

| 样本 | 朱雀结果 | 当前检测 | 平均误差 |
|---|---:|---:|---:|
| A1 人工 | 100 / 0 / 0 | 100 / 0 / 0 | 0.0% |
| A2 纯 AI | 0 / 0 / 100 | 0 / 0 / 100 | 0.0% |
| H1 低频词 | 0 / 100 / 0 | 0 / 100 / 0 | 0.0% |
| F6 镜头链 | 人工 19 | 人工 29.36 | 10.4%（仅标注人工维度） |
| F4 连接词 | 人工 61 | 人工 72.39 | 11.4%（仅标注人工维度） |
| F8 均匀句长 | 100 / 0 / 0 | 100 / 0 / 0 | 0.0% |
| G1 修仙 | 0 / 100 / 0 | 0 / 100 / 0 | 0.0% |
| G3 推理 | 0 / 0 / 100 | 0 / 0 / 100 | 0.0% |
| M4 DeepSeek | 0 / 100 / 0 | 0 / 100 / 0 | 0.0% |
| Q6 前置混合 | 57.37 / 0 / 42.63 | 57.02 / 0 / 42.98 | 0.2% |
| K4 交替混合 | 28.09 / 71.91 / 0 | 30.43 / 69.57 / 0 | 1.6% |
| WS4 词对交换 | 100 / 0 / 0 | 100 / 0 / 0 | 0.0% |

F4/F6 的原始实验只记录人工占比，缺失疑似/AI拆分；当前不臆造缺失标签继续过拟合。四段硬分类也无法精确表达 61% 与 19%，因此保留方向正确的最小残差。

云端或本地 API 未返回有效 `logprobs` 时不再切换启发式结果，而是明确失败。没有 token 概率就无法满足朱雀对齐检测的基本输入契约，返回启发式百分比会制造虚假精度。

## 复现命令

校准脚本需要先打包为临时 ESM 文件，避免 `jiti` 与 `node-llama-cpp` 的顶层 await 冲突：

```bash
rtk ./node_modules/.bin/esbuild scripts/calibrate-zhuque-alignment.ts --bundle --platform=node --format=esm --external:node-llama-cpp --outfile=node_modules/.cache/anovel-calibrate-zhuque.mjs
rtk node node_modules/.cache/anovel-calibrate-zhuque.mjs
```

校准指标会写入 `/tmp/anovel-zhuque-calibration-cache.json`，中途中止后再次运行可从已完成样本继续。缓存完整时脚本不会初始化 GPU。若代码中的分段或模型指标计算方式发生变化，应先删除该缓存再重跑。

最后验证：

```bash
rtk npm run test:zhuque-alignment
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
- `scripts/zhuque-calibration-corpus.ts`
