import assert from 'node:assert/strict'
import { novelExecutionModelProtocolError } from '../src/main/context/goal-routine/novel-execution-gate'

const capabilityFailure = novelExecutionModelProtocolError({
  success: false,
  content: '',
  error: 'MODEL_CAPABILITY_UNSUPPORTED: 当前模型不支持原生 JSON Schema'
}, '模型未返回内容')

assert.match(
  capabilityFailure,
  /^capability_failure：MODEL_CAPABILITY_UNSUPPORTED:/
)
assert.doesNotMatch(capabilityFailure, /^transport_failure：/)

process.stdout.write('novel execution model capability tests passed\n')
