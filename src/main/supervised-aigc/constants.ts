import path from 'path'

export const SUPERVISED_AIGC_MODEL = {
  id: 'aigc-detector-zh-v3-int8',
  name: '中文 AIGC Detector V3',
  description: '中文监督分类模型，覆盖 DeepSeek、Qwen、GPT 等生成文本',
  sourceModel: 'yuchuantian/AIGC_detector_zhv3',
  revision: 'e6c77fd62955fac134e76deb5396806f6d35fd30',
  model: {
    filename: 'model_quantized.onnx',
    sizeBytes: 103_097_593,
    sha256: '57e5ec316f7ce764e94ba4f301cf492f3f22f22ea0cd3b385ebad847a42de40c',
    url: 'https://hf-mirror.com/Eslzzyl/aigc-detector-zh-onnx/resolve/e6c77fd62955fac134e76deb5396806f6d35fd30/onnx/model_quantized.onnx'
  },
  tokenizer: {
    filename: 'tokenizer.json',
    sizeBytes: 439_118,
    sha256: 'e3664152464ac6604e88e0b5348cb0819f5e2b75dc0a3f976dd4ab5058441b01',
    url: 'https://hf-mirror.com/Eslzzyl/aigc-detector-zh-onnx/resolve/e6c77fd62955fac134e76deb5396806f6d35fd30/tokenizer.json'
  },
  maxTokens: 512
} as const

export function getSupervisedAigcModelDir(userDataPath: string): string {
  return path.join(userDataPath, 'models', SUPERVISED_AIGC_MODEL.id)
}

export function getSupervisedAigcModelPath(userDataPath: string): string {
  return path.join(getSupervisedAigcModelDir(userDataPath), SUPERVISED_AIGC_MODEL.model.filename)
}

export function getSupervisedAigcTokenizerPath(userDataPath: string): string {
  return path.join(getSupervisedAigcModelDir(userDataPath), SUPERVISED_AIGC_MODEL.tokenizer.filename)
}
