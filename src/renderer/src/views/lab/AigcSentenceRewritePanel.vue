<script setup lang="ts">
import { computed } from 'vue'
import type {
  AigcSentencePatch,
  AigcSentencePatchDecision,
  AigcRewriteGoalResult
} from '../../../../shared/aigc-sentence-rewrite-types'
import { AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT } from '../../../../shared/aigc-sentence-rewrite-types'
import {
  HUMAN_REWRITE_AI_SYMPTOM_LABELS,
  HUMAN_REWRITE_SCENE_LABELS
} from '../../../../shared/human-rewrite-reference-types'

const props = defineProps<{
  patches: AigcSentencePatch[]
  decisions: Record<string, AigcSentencePatchDecision>
  previewText: string
  rewriting?: boolean
  goal?: AigcRewriteGoalResult | null
}>()

const emit = defineEmits<{
  accept: [id: string]
  reject: [id: string]
  acceptAll: []
  applyAccepted: []
}>()

const passedCount = computed(() => props.patches.filter(item => item.status === 'passed').length)
const acceptedCoveragePercent = computed(() => {
  const total = props.patches.reduce(
    (sum, patch) => sum + Math.max(1, patch.originalText.replace(/\s+/g, '').length),
    0
  )
  if (total === 0) return 0
  const accepted = props.patches.reduce((sum, patch) => {
    if (patch.status !== 'passed' || props.decisions[patch.id] !== 'accepted') return sum
    return sum + Math.max(1, patch.originalText.replace(/\s+/g, '').length)
  }, 0)
  return Math.round(accepted / total * 1000) / 10
})
const canApplyPatches = computed(() =>
  props.goal?.status === 'awaiting_recheck' || props.goal?.status === 'achieved'
)

const statusMeta = {
  analyzing: { label: '分析中', css: 'badge-info' },
  rewriting: { label: '改写中', css: 'badge-info' },
  improving: { label: '持续降险', css: 'badge-info' },
  passed: { label: '质量门禁通过', css: 'badge-success' },
  rejected: { label: '候选未通过', css: 'badge-warning' },
  unmatched: { label: '无匹配案例', css: 'badge-error' },
  unchanged: { label: '保留原句', css: 'badge-ghost' }
} as const
</script>

<template>
  <section class="border border-base-300 rounded-lg bg-base-100 min-h-0 flex flex-col">
    <header class="px-3 py-2 border-b border-base-300 flex items-center gap-2 shrink-0">
      <span class="text-xs font-semibold">全文场景块改写</span>
      <span class="text-[10px] text-base-content/50">事实锚点 · 深度重组 · 全文双模型复检 · 失败不写回</span>
      <span v-if="rewriting" class="loading loading-spinner loading-xs ml-auto" />
      <template v-else-if="passedCount > 0 && canApplyPatches">
        <button type="button" class="btn btn-ghost btn-xs ml-auto" @click="emit('acceptAll')">
          全部接受
        </button>
        <button
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="acceptedCoveragePercent < AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT"
          @click="emit('applyAccepted')"
        >应用已接受（覆盖 {{ acceptedCoveragePercent }}%）</button>
      </template>
    </header>

    <div
      v-if="goal"
      class="px-3 py-2 border-b text-[11px]"
      :class="goal.status === 'achieved'
        ? 'border-success/30 bg-success/10 text-success'
        : goal.status === 'awaiting_recheck'
          ? 'border-info/30 bg-info/10 text-info'
          : 'border-warning/30 bg-warning/10 text-warning'"
    >
      <div class="font-medium">
        {{ goal.status === 'achieved'
          ? '生成质量与本地风险门禁通过'
          : goal.status === 'awaiting_recheck'
            ? '仅通过生成质量门禁，尚未完成风险复检'
            : '改写未通过双重门禁，拒绝应用' }}
      </div>
      <div v-if="goal.status === 'awaiting_recheck'" class="mt-0.5">
        已生成 {{ passedCount }} 个场景块补丁，通过块覆盖 {{ goal.passedCoveragePercent }}%。如手动应用部分补丁，必须重新检测，旧结果不会沿用。
        <template v-if="goal.remainingSentenceIds.length">另有 {{ goal.remainingSentenceIds.length }} 个目标块未生成有效补丁。</template>
      </div>
      <div v-else-if="goal.status === 'not_achieved'" class="mt-0.5 tabular-nums">
        <template v-if="goal.localVerification">
          已完成 {{ goal.localVerification.attempts }} 轮本地复检，当前为人工特征 {{ goal.humanPercent }}% · 疑似AI {{ goal.suspectedAiPercent }}% · AI {{ goal.aiPercent }}%；未应用改写。
          <template v-if="goal.localVerification.reasons.length">原因：{{ goal.localVerification.reasons.join('；') }}。</template>
        </template>
        <template v-else>
          目标文本覆盖 {{ goal.targetCoveragePercent }}%，通过质量门禁的块仅覆盖 {{ goal.passedCoveragePercent }}%，不允许应用不完整改写。
        </template>
      </div>
      <div v-else class="mt-0.5 tabular-nums">
        本地特征覆盖：人工特征 {{ goal.humanPercent }}% · 疑似AI {{ goal.suspectedAiPercent }}% · AI {{ goal.aiPercent }}%
        <template v-if="goal.localVerification">（第 {{ goal.localVerification.attempts }} 轮通过）</template>
      </div>
    </div>

    <div v-if="previewText" class="border-b border-base-300 bg-base-200/20">
      <div class="px-3 py-1 text-[10px] font-medium text-base-content/55">改写预览（待定和已接受生效，已拒绝恢复原句）</div>
      <pre class="max-h-40 overflow-auto px-3 pb-2 text-xs whitespace-pre-wrap break-words leading-5 font-sans">{{ previewText }}</pre>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-2 space-y-2">
      <div v-if="patches.length === 0" class="h-full min-h-28 flex items-center justify-center text-xs text-base-content/40">
        点击“一键改写”后，这里会实时显示每个场景块的事实锚点、诊断与生成质量门禁结果
      </div>
      <article
        v-for="patch in patches"
        :key="patch.id"
        class="rounded-md border border-base-300/80 bg-base-100 p-2 text-[11px]"
      >
        <div class="flex items-center gap-1.5 flex-wrap">
          <code class="text-[9px] text-base-content/40">{{ patch.id }}</code>
          <span v-if="patch.scope === 'block'" class="badge badge-outline badge-xs">{{ patch.sentenceCount }}句语义块</span>
          <span class="badge badge-xs" :class="statusMeta[patch.status].css">{{ statusMeta[patch.status].label }}</span>
          <span
            v-for="scene in patch.sceneTypes"
            :key="scene"
            class="badge badge-outline badge-xs"
          >{{ HUMAN_REWRITE_SCENE_LABELS[scene] }}</span>
          <span v-if="patch.windowScoreAfter !== undefined" class="ml-auto text-[10px] tabular-nums text-base-content/55">
            目标块风险 {{ patch.windowScoreBefore.toFixed(1) }} → {{ patch.windowScoreAfter.toFixed(1) }}
          </span>
          <span v-else class="ml-auto text-[10px] tabular-nums text-base-content/45">
            目标块风险 {{ patch.windowScoreBefore.toFixed(1) }}
          </span>
        </div>

        <p v-if="patch.evidence" class="mt-1 text-base-content/60">
          {{ patch.evidence }}
          <span v-if="patch.aiSymptoms.length"> · {{ patch.aiSymptoms.map(item => HUMAN_REWRITE_AI_SYMPTOM_LABELS[item]).join('、') }}</span>
        </p>
        <div class="mt-1.5 grid grid-cols-1 xl:grid-cols-2 gap-1.5">
          <div class="rounded bg-error/5 px-2 py-1.5 whitespace-pre-wrap break-words">
            <span class="text-[9px] text-error/65 block">原语义块</span>{{ patch.originalText }}
          </div>
          <div v-if="patch.rewrittenText" class="rounded bg-success/5 px-2 py-1.5 whitespace-pre-wrap break-words">
            <span class="text-[9px] text-success/65 block">改写语义块</span>{{ patch.rewrittenText }}
          </div>
        </div>
        <p v-if="patch.referenceTitles.length" class="mt-1 text-[10px] text-primary/70">
          参考：{{ patch.referenceTitles.join('、') }}
        </p>
        <p v-if="patch.issues.length" class="mt-1 text-[10px] text-warning">
          {{ patch.issues.join('；') }}
        </p>

        <details v-if="patch.attempts?.length" class="mt-1.5 rounded border border-base-300/70 bg-base-200/20 px-2 py-1">
          <summary class="cursor-pointer text-[10px] text-base-content/55">
            查看 {{ patch.attempts.length }} 轮生成候选与质量门禁结果
          </summary>
          <div v-for="attempt in patch.attempts" :key="attempt.attempt" class="mt-1.5 space-y-1">
            <p class="text-[10px] font-medium text-base-content/60">第 {{ attempt.attempt }} 轮</p>
            <div
              v-for="(candidate, candidateIndex) in attempt.candidates"
              :key="candidateIndex"
              class="rounded bg-base-100 px-2 py-1 text-[10px]"
            >
              <div class="flex gap-2">
                <span>候选 {{ candidateIndex + 1 }}</span>
                <span class="ml-auto tabular-nums">
                  {{ patch.scope === 'block' ? '改动' : '风险' }} {{ candidate.score.toFixed(1) }}{{ patch.scope === 'block' ? '%' : '' }}
                </span>
              </div>
              <p class="mt-0.5 whitespace-pre-wrap break-words text-base-content/70">{{ candidate.text }}</p>
              <p v-if="candidate.issues.length" class="mt-0.5 text-warning">{{ candidate.issues.join('；') }}</p>
            </div>
          </div>
        </details>

        <div v-if="patch.status === 'passed'" class="mt-2 flex items-center justify-end gap-1">
          <button
            type="button"
            class="btn btn-xs"
            :class="decisions[patch.id] === 'rejected' ? 'btn-error' : 'btn-ghost'"
            @click="emit('reject', patch.id)"
          >拒绝</button>
          <button
            type="button"
            class="btn btn-xs"
            :class="decisions[patch.id] === 'accepted' ? 'btn-success' : 'btn-outline'"
            @click="emit('accept', patch.id)"
          >接受</button>
        </div>
      </article>
    </div>
  </section>
</template>
