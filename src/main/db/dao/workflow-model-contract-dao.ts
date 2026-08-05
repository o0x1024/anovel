import { createHash } from 'node:crypto'
import { BaseDAO } from './base-dao'

export interface FrozenModelSelection {
  provider: string
  modelName: string
  apiBase: string
  providerProtocol: 'openai' | 'gemini' | 'anthropic'
  maxContextTokens: number
  providerOptionsJson: string | null
  thinkingEnabled?: boolean
}

export interface WorkflowModelContract {
  version: 1
  global: FrozenModelSelection
  body: FrozenModelSelection
  stepOverrides: Record<string, FrozenModelSelection>
  generationParams: {
    temperature: number
    maxTokens: number
    frequencyPenalty: number
    presencePenalty: number
    topP: number
  }
}

interface WorkflowModelContractRow {
  run_id: number
  contract_version: number
  contract_hash: string
  contract_json: string
  create_time: string
}

function contractHash(contract: WorkflowModelContract): string {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex')
}

export class WorkflowModelContractDAO extends BaseDAO {
  get(runId: number): WorkflowModelContract | null {
    const row = this.getRow(runId)
    if (!row) return null
    const contract = JSON.parse(row.contract_json) as WorkflowModelContract
    if (
      contract.version !== row.contract_version
      || contractHash(contract) !== row.contract_hash
    ) {
      throw new Error(`工作流 ${runId} 的模型执行合同校验失败`)
    }
    return contract
  }

  create(runId: number, contract: WorkflowModelContract): WorkflowModelContract {
    const hash = contractHash(contract)
    this.run(
      `INSERT INTO workflow_model_contracts (
         run_id, contract_version, contract_hash, contract_json
       ) VALUES (?, ?, ?, ?)`,
      [runId, contract.version, hash, JSON.stringify(contract)]
    )
    return contract
  }

  getHash(runId: number): string | null {
    return this.getRow(runId)?.contract_hash ?? null
  }

  private getRow(runId: number): WorkflowModelContractRow | undefined {
    return super.get<WorkflowModelContractRow>(
      'SELECT * FROM workflow_model_contracts WHERE run_id = ?',
      [runId]
    )
  }
}

export const workflowModelContractDAO = new WorkflowModelContractDAO()
