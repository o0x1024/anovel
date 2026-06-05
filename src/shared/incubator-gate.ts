/**
 * 候选入槽最低总分。
 * M1 启发式校准后，合格扩写/变体约 70–82；过短摘要仍可能低于此线。
 */
export const INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE = 68

/** 冻结前冲突闭环 / 可连载性最低分 */
export const INCUBATOR_GATE_MIN_SERIALIZABILITY = 70
export const INCUBATOR_GATE_MIN_CONFLICT_CLOSURE = 70

/** 冻结前至少填满的槽位数（共 6 槽） */
export const INCUBATOR_FREEZE_MIN_FILLED_SLOTS = 5
