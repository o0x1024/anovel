import type {
  HumanRewriteAiSymptom,
  HumanRewriteReference,
  HumanRewriteReferenceInput,
  HumanRewriteSceneType
} from '../../../shared/human-rewrite-reference-types'
import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_SCENE_TYPES
} from '../../../shared/human-rewrite-reference-types'
import { BaseDAO } from './base-dao'

interface HumanRewriteReferenceRow {
  id: number
  title: string
  scene_types_json: string
  ai_symptoms_json: string
  original_text: string
  rewritten_text: string
  rewrite_principles_json: string
  preserved_facts_json: string
  forbidden_changes_json: string
  enabled: number
  priority: number
  create_time: string
  update_time: string
}

function parseArray<T extends string>(json: string): T[] {
  const value = JSON.parse(json) as unknown
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('人工化改写案例数据损坏')
  }
  return value as T[]
}

function mapRow(row: HumanRewriteReferenceRow): HumanRewriteReference {
  return {
    id: row.id,
    title: row.title,
    sceneTypes: parseArray<HumanRewriteSceneType>(row.scene_types_json),
    aiSymptoms: parseArray<HumanRewriteAiSymptom>(row.ai_symptoms_json),
    originalText: row.original_text,
    rewrittenText: row.rewritten_text,
    rewritePrinciples: parseArray<string>(row.rewrite_principles_json),
    preservedFacts: parseArray<string>(row.preserved_facts_json),
    forbiddenChanges: parseArray<string>(row.forbidden_changes_json),
    enabled: row.enabled === 1,
    priority: row.priority,
    createTime: row.create_time,
    updateTime: row.update_time
  }
}

function validateInput(input: HumanRewriteReferenceInput): HumanRewriteReferenceInput {
  const title = input.title.trim()
  const originalText = input.originalText.trim()
  const rewrittenText = input.rewrittenText.trim()
  const sceneTypes = Array.from(new Set(input.sceneTypes))
  const aiSymptoms = Array.from(new Set(input.aiSymptoms))
  const rewritePrinciples = input.rewritePrinciples.map(item => item.trim()).filter(Boolean)
  const validScenes = new Set<string>(HUMAN_REWRITE_SCENE_TYPES)
  const validSymptoms = new Set<string>(HUMAN_REWRITE_AI_SYMPTOMS)
  if (!title) throw new Error('案例名称不能为空')
  if (sceneTypes.length === 0 || sceneTypes.length > 2 || sceneTypes.some(item => !validScenes.has(item))) {
    throw new Error('请选择 1-2 个有效场景类型')
  }
  if (aiSymptoms.length === 0 || aiSymptoms.length > 3 || aiSymptoms.some(item => !validSymptoms.has(item))) {
    throw new Error('请选择 1-3 个有效 AI 痕迹')
  }
  if (!originalText || !rewrittenText) throw new Error('改写前和改写后文本不能为空')
  if (rewritePrinciples.length === 0) throw new Error('至少填写一条改写原则')
  return {
    ...input,
    title,
    sceneTypes,
    aiSymptoms,
    originalText,
    rewrittenText,
    rewritePrinciples,
    preservedFacts: input.preservedFacts.map(item => item.trim()).filter(Boolean),
    forbiddenChanges: input.forbiddenChanges.map(item => item.trim()).filter(Boolean),
    priority: Math.max(0, Math.min(100, Math.round(input.priority ?? 50)))
  }
}

export class HumanRewriteReferenceDAO extends BaseDAO {
  list(): HumanRewriteReference[] {
    return this.all<HumanRewriteReferenceRow>(
      'SELECT * FROM aigc_rewrite_examples ORDER BY priority DESC, update_time DESC, id DESC'
    ).map(mapRow)
  }

  listEnabled(): HumanRewriteReference[] {
    return this.all<HumanRewriteReferenceRow>(
      'SELECT * FROM aigc_rewrite_examples WHERE enabled = 1 ORDER BY priority DESC, update_time DESC, id DESC'
    ).map(mapRow)
  }

  getById(id: number): HumanRewriteReference | undefined {
    const row = this.get<HumanRewriteReferenceRow>('SELECT * FROM aigc_rewrite_examples WHERE id = ?', [id])
    return row ? mapRow(row) : undefined
  }

  create(raw: HumanRewriteReferenceInput): HumanRewriteReference {
    const input = validateInput(raw)
    const id = this.insert(
      `INSERT INTO aigc_rewrite_examples
       (title, scene_types_json, ai_symptoms_json, original_text, rewritten_text,
        rewrite_principles_json, preserved_facts_json, forbidden_changes_json,
        enabled, priority, update_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        input.title,
        JSON.stringify(input.sceneTypes),
        JSON.stringify(input.aiSymptoms),
        input.originalText,
        input.rewrittenText,
        JSON.stringify(input.rewritePrinciples),
        JSON.stringify(input.preservedFacts),
        JSON.stringify(input.forbiddenChanges),
        input.enabled === false ? 0 : 1,
        input.priority
      ]
    )
    return this.getById(id)!
  }

  update(id: number, raw: HumanRewriteReferenceInput): boolean {
    if (!this.getById(id)) return false
    const input = validateInput(raw)
    const result = this.run(
      `UPDATE aigc_rewrite_examples
       SET title = ?, scene_types_json = ?, ai_symptoms_json = ?, original_text = ?,
           rewritten_text = ?, rewrite_principles_json = ?, preserved_facts_json = ?,
           forbidden_changes_json = ?, enabled = ?, priority = ?, update_time = datetime('now')
       WHERE id = ?`,
      [
        input.title,
        JSON.stringify(input.sceneTypes),
        JSON.stringify(input.aiSymptoms),
        input.originalText,
        input.rewrittenText,
        JSON.stringify(input.rewritePrinciples),
        JSON.stringify(input.preservedFacts),
        JSON.stringify(input.forbiddenChanges),
        input.enabled === false ? 0 : 1,
        input.priority,
        id
      ]
    )
    return result.changes > 0
  }

  toggleEnabled(id: number, enabled: boolean): boolean {
    const result = this.run(
      `UPDATE aigc_rewrite_examples
       SET enabled = ?, update_time = datetime('now') WHERE id = ?`,
      [enabled ? 1 : 0, id]
    )
    return result.changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM aigc_rewrite_examples WHERE id = ?', [id]).changes > 0
  }
}

export const humanRewriteReferenceDAO = new HumanRewriteReferenceDAO()
