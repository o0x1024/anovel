import { appPreferenceDAO, assistantRoleDAO } from '../../db'

export const ASSISTANT_GLOBAL_ROLE_KEY = 'assistant_global_role_id'

/** 助手对话仅使用全局角色，会话表 role_id 不再参与推理。 */
export function resolveAssistantGlobalRoleId(): number | null {
  const raw = appPreferenceDAO.getPreference(ASSISTANT_GLOBAL_ROLE_KEY)
  const preferredRoleId = raw ? Number(raw) : NaN
  if (Number.isFinite(preferredRoleId) && preferredRoleId > 0) {
    const role = assistantRoleDAO.getById(preferredRoleId)
    if (role) return preferredRoleId
  }
  return null
}
