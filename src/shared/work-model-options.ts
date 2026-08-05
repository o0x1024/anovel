/** 作品级模型选项（正文工作台右上角模型 / 深度思考开关） */
export interface WorkModelOptions {
  modelType?: string
  modelName?: string
  thinkingEnabled?: boolean
}

export function withWorkModelOptions<T extends object>(
  request: T,
  modelOpts?: WorkModelOptions
): T & WorkModelOptions {
  if (!modelOpts) return request
  return {
    ...request,
    ...(modelOpts.modelType ? { modelType: modelOpts.modelType, modelName: modelOpts.modelName } : {}),
    ...(modelOpts.thinkingEnabled !== undefined ? { thinkingEnabled: modelOpts.thinkingEnabled } : {})
  }
}
