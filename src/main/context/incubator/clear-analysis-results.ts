import {
  INCUBATOR_ANALYSIS_CANDIDATE_SOURCE_STEPS,
  INCUBATOR_ANALYSIS_SETTING_STEPS
} from '../../../shared/incubator-analysis-prompts'
import { coreSettingDAO } from '../../db/dao/core-setting-dao'
import { incubatorCandidateDAO, incubatorStateDAO } from '../../db/dao/incubator'
import { inferStateAfterCandidates } from './state-machine'
import { sanitizeIncubatorFkOrphans } from './sanitize-incubator-fk'

export interface ClearIncubatorAnalysisResult {
  deletedSettings: number
  deletedCandidates: number
}

/** 清除 AI 分析生成的设定与候选（保留 manual 候选、槽位与种子） */
export function clearIncubatorAnalysisResults(workId: number): ClearIncubatorAnalysisResult {
  const deletedSettings = coreSettingDAO.deleteByWorkAndTypes(
    workId,
    [...INCUBATOR_ANALYSIS_SETTING_STEPS]
  )
  const deletedCandidates = incubatorCandidateDAO.deleteByWorkSourceSteps(
    workId,
    [...INCUBATOR_ANALYSIS_CANDIDATE_SOURCE_STEPS]
  )

  sanitizeIncubatorFkOrphans(workId)

  const remaining = incubatorCandidateDAO.listByWork(workId).length
  incubatorStateDAO.setState(workId, inferStateAfterCandidates(remaining))

  return { deletedSettings, deletedCandidates }
}
