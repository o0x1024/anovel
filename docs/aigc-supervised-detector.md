# 中文监督 AIGC 检测模型

## 目标

AI 实验室的检测结果同时使用两类独立证据：

1. Qwen3.5 4B 困惑度、Top-5 命中率、重叠 token 窗口和结构特征。
2. 中文人类/AI语料监督训练的 BERT 二分类模型。

单一困惑度模型只衡量“文本对语言模型有多可预测”，不能直接代表文本来源；监督分类模型也会受训练领域影响。因此生产结论融合两路证据，并按外部实验集验证每一路证据可以承担的方向。

中文统计检测基座固定为 `qwen3.5-4b-q4`。正式检测链路不接受工作区当前模型、任意 API 模型或历史模型选择覆盖。MiniCPM3 4B 已从产品模型注册表移除；历史保存的该模型选择不参与融合，也不提供运行时回退。

Qwen3.5 4B 工件固定为 2,740,937,888 字节，SHA-256 为 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`。首次使用会执行完整摘要校验并写入带文件修改时间的验证清单；之后只有字节数、修改时间和摘要清单同时匹配才视为就绪。校验失败会删除损坏工件并重新下载，断点下载源不支持 Range 时会安全地从头覆盖。

## 模型工件

- 上游模型：`yuchuantian/AIGC_detector_zhv3`
- ONNX 导出：`Eslzzyl/aigc-detector-zh-onnx`
- 架构：BERT-base，12层，768隐藏维度
- 量化：动态 INT8
- 输入：`input_ids`、`attention_mask`、`token_type_ids`
- 输出：`[Human, AI]` logits
- 模型大小：103,097,593字节
- 许可证：Apache-2.0
- 固定修订：`e6c77fd62955fac134e76deb5396806f6d35fd30`

下载器同时固定模型和 tokenizer 的字节数与 SHA-256。文件不完整、内容变化或校验失败时检测直接失败，不会退回单模型结论。

## 推理与融合

- 原文按最多480字符、重叠160字符建立监督模型窗口。
- 窗口概率按字符重叠归因到现有检测片段。
- `docs/experiments/` 实测表明该监督模型适合提供 AI 正证据，但低分存在明显漏检，不能作为人工证据。
- 监督 AI 概率达到45%且高于统计风险时，对新增风险差使用60%权重；其余情况保留原困惑度与结构风险。
- 两路风险相差40分及以上时记录分歧覆盖率，但低监督分不得把统计侧的高风险强制降级。
- AI类别采用三条独立放行路径：词语可预测性达到90；或中文监督整文AI达到85%；或中文监督整文AI达到45%且整篇结构风险达到40。三条路径均未命中时，风险即使进入AI区也归入疑似AI。
- 三条路径来自Qwen3.5 4B同文实测：一篇朱雀人工100%文本监督AI 3.8、结构风险25.7；两篇朱雀AI100%文本分别呈现监督AI 53.3加结构风险44.8，以及监督AI 96.9的证据模式。

阈值和证据方向来自分层实验集；`holdout`、`blind` 与不可读的 `robustness_only` 样本不得参与拟合。

检测输出是风险分层，不是作者身份鉴定。AI 辅助改写后的结果保留 `ai_assisted` 来源记录，即使本地特征全部落入“人工特征”区间，也不得展示为“人工作者证明”。

## 验证

```bash
npm run test:aigc-supervised
npm run test:zhuque-alignment
npm run test:aigc-rewrite
npm run build
```

下载并校验真实工件后，可运行：

```bash
./node_modules/.bin/jiti scripts/test-aigc-supervised-onnx.ts \
  /path/to/model_quantized.onnx \
  /path/to/tokenizer.json \
  /optional/path/to/sample.txt
```

当前实验分层、基线误差和复现命令见 `docs/aigc-zhuque-experiment-corpus.md`。发布前仍需补充按题材、长度、来源模型分层的真实人工盲测，重点报告人工误报率、AI召回率、Macro-F1、检测器分歧率和校准误差。
