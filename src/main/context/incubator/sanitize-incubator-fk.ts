import { workDAO } from '../../db'
import {
  incubatorCandidateDAO,
  incubatorDraftSlotDAO,
  incubatorStateDAO,
  incubatorVersionDAO
} from '../../db/dao/incubator'

/**
 * 修复孵化器表中的悬空外键引用（开启 foreign_keys 后会导致写入失败）
 */
export function sanitizeIncubatorFkOrphans(workId: number): void {
  incubatorDraftSlotDAO.sanitizeInvalidSourceCandidates(workId)
  incubatorVersionDAO.sanitizeInvalidBaseVersions(workId)
  incubatorStateDAO.sanitizeInvalidBranchBase(workId)
}

export function assertIncubatorWorkExists(workId: number): void {
  if (!Number.isFinite(workId) || workId <= 0) {
    throw new Error(`无效的作品 ID: ${workId}`)
  }
  if (!workDAO.getById(workId)) {
    throw new Error(`作品不存在或已删除（id=${workId}），无法加载孵化器数据`)
  }
}

export function resolveSourceCandidateId(candidateId: number | null | undefined): number | null {
  if (candidateId == null) return null
  const row = incubatorCandidateDAO.getById(candidateId)
  return row ? candidateId : null
}
