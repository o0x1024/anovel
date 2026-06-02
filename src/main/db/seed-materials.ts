import { materialDAO } from './dao/material-dao'

const PRESETS = [
  { category: 'character', title: '主角模板', content: '姓名：\n年龄：\n外貌特征：\n性格核心（3个关键词）：\n内心渴望：\n最大恐惧：\n说话习惯：\n与主角的关系：' },
  { category: 'character', title: '反派动机卡', content: '表面目标：\n真实动机：\n与主角的镜像关系：\n不可退让的底线：\n最脆弱的时刻：' },
  { category: 'scene', title: '场景氛围', content: '地点：\n时间/天气：\n五感细节（视/听/嗅/触/味）：\n情绪基调：\n与情节的关联：' },
  { category: 'scene', title: '冲突场景', content: '参与角色：\n冲突焦点：\n空间布局（谁占上风）：\n潜台词：\n场景结束时的状态变化：' },
  { category: 'dialogue', title: '对话张力', content: 'A 想说什么（表面）：\nA 真正想表达：\nB 的误解/防御：\n未说出口的潜台词：\n对话后的关系变化：' },
  { category: 'dialogue', title: '信息博弈', content: '谁掌握更多信息：\n需要隐藏的信息：\n试探性问句：\n关键转折句：\n读者此时应知道什么：' },
  { category: 'plot', title: '桥段-误会升级', content: '触发事件：\n误解如何产生：\n各方掌握的信息差：\n升级节点（2-3个）：\n真相揭露时的情感冲击：' },
  { category: 'plot', title: '桥段-绝境反转', content: '绝境描述：\n看似无解的原因：\n伏笔/道具/人物：\n反转瞬间：\n反转后的新局面：' },
  { category: 'plot', title: '高潮后轻量日常', content: '场景：\n参与角色：\n贴人设的小互动/吐槽：\n藏着的温情细节：\n与下一冲突的过渡' },
  { category: 'character', title: '人设三维卡片', content: '姓名/角色定位(主/配/反)：\n记忆标签（1个）：\n核心矛盾：\n本能/理性/隐藏反应：\n语言风格：\n关系绑定：\n成长触发点：' },
  { category: 'plot', title: 'ABC爽点链规划', content: 'A剧情（已爽完）：\nB剧情（当前）：\nC剧情（铺垫中）：\nD剧情（构思中）：\n本章 beat_role：' },
  { category: 'scene', title: '战斗场面', content: '战斗目的（推进情节/展示能力/塑造人物）：\n空间与站位：\n3个关键动作画面：\n胜负转折点：\n战后状态变化：' }
]

export function seedBuiltinMaterials(): void {
  const existing = materialDAO.listGlobal()
  if (existing.length > 0) return

  for (const preset of PRESETS) {
    materialDAO.create({ ...preset, work_id: undefined })
  }
  console.log(`[DB] Seeded ${PRESETS.length} built-in materials`)
}
