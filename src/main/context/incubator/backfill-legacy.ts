import { coreSettingDAO, workDAO } from '../../db'
import {
  incubatorSeedDAO,
  incubatorCandidateDAO,
  incubatorStateDAO
} from '../../db/dao/incubator'
import { parseExpansionVersions } from '../parse-expansion'
import { parseIncubatorVariants } from '../parse-variants'

/**
 * 将旧 core_settings（idea / incubator_*）回填到新表，幂等、失败不阻断。
 * 仅在首次（state=SeedReady 且无候选）时执行，用户删光候选后不再回填。
 */
export function backfillIncubatorFromLegacy(workId: number): { warnings: string[] } {
  const warnings: string[] = []
  if (!workDAO.getById(workId)) {
    warnings.push('作品不存在，跳过孵化器回填')
    return { warnings }
  }
  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))

  const stateRow = incubatorStateDAO.ensure(workId)

  const idea = byType.get('idea')?.trim()
  if (idea && !incubatorSeedDAO.getByWork(workId)) {
    incubatorSeedDAO.upsert(workId, idea)
  }

  if (stateRow.state !== 'SeedReady') return { warnings }

  const existingCandidates = incubatorCandidateDAO.listByWork(workId)
  if (existingCandidates.length > 0) return { warnings }

  const variantsRaw = byType.get('incubator_variants')?.trim()
  if (variantsRaw) {
    try {
      const items = parseIncubatorVariants(variantsRaw, true)
      for (const v of items) {
        incubatorCandidateDAO.create({
          workId,
          sourceStep: 'variants',
          title: v.title,
          summary: v.summary,
          dimension: v.dimension ?? null,
          status: 'new'
        })
      }
    } catch {
      warnings.push('变体探索历史未能回填为候选')
    }
  }

  const expandRaw = byType.get('incubator_expand')?.trim()
  if (expandRaw) {
    try {
      const versions = parseExpansionVersions(expandRaw)
      for (const ver of versions) {
        incubatorCandidateDAO.create({
          workId,
          sourceStep: 'expand',
          title: ver.title,
          summary: ver.summary,
          highlights: ver.highlights ?? null,
          audience: ver.audience ?? null,
          status: 'new'
        })
      }
    } catch {
      warnings.push('方向扩写历史未能回填为候选')
    }
  }

  const count = incubatorCandidateDAO.listByWork(workId).length
  if (count > 0) {
    incubatorStateDAO.setState(workId, 'CandidatesGenerated')
  }

  return { warnings }
}
