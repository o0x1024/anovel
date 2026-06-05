<script setup lang="ts">
import { ref, onMounted, onActivated, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  DEFAULT_NOVEL_LENGTH,
  NOVEL_LENGTH_PRESETS,
  novelLengthSummary,
  type NovelLength
} from '../../../../shared/writing-plan-presets'
import {
  WORK_COVER_ACCEPT,
  isWorkCoverFile,
  pickWorkCover,
  removeWorkCover,
  setWorkCoverFromFile,
  workCoverSrc
} from '../../utils/workCover'

const router = useRouter()

const VIEW_MODE_KEY = 'workListViewMode'
type WorkViewMode = 'card' | 'list'

function loadViewMode(): WorkViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'card'
}

interface Work {
  id: number
  title: string
  description: string | null
  cover_image: string | null
  create_time: string
  update_time: string
}

const works = ref<Work[]>([])
const loading = ref(true)
const showCreateDialog = ref(false)
const showEditDialog = ref(false)
const newWork = ref({ title: '', description: '' })
const newNovelLength = ref<NovelLength>(DEFAULT_NOVEL_LENGTH)
const editWork = ref({ id: 0, title: '', description: '', cover_image: null as string | null })
const creating = ref(false)
const saving = ref(false)
const backupBusy = ref<number | null>(null)
const coverBusy = ref<number | null>(null)
const coverInputRef = ref<HTMLInputElement | null>(null)
const coverPickerTarget = ref<'create' | number | null>(null)
const pendingCoverFile = ref<File | null>(null)
const pendingCoverPreview = ref<string | null>(null)
const viewMode = ref<WorkViewMode>(loadViewMode())

async function reloadWorks() {
  works.value = await window.anovel.invoke('work:list') as Work[]
}

function clearPendingCover() {
  if (pendingCoverPreview.value) URL.revokeObjectURL(pendingCoverPreview.value)
  pendingCoverFile.value = null
  pendingCoverPreview.value = null
}

function openCreateDialog() {
  clearPendingCover()
  showCreateDialog.value = true
}

function triggerCoverPicker(target: 'create' | number) {
  coverPickerTarget.value = target
  coverInputRef.value?.click()
}

async function handleCoverFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const target = coverPickerTarget.value
  coverPickerTarget.value = null
  if (!file || target === null) return

  if (!isWorkCoverFile(file)) {
    alert('请选择 JPG、PNG、WebP 或 GIF 图片')
    return
  }

  if (target === 'create') {
    clearPendingCover()
    pendingCoverFile.value = file
    pendingCoverPreview.value = URL.createObjectURL(file)
    return
  }

  coverBusy.value = target
  try {
    await setWorkCoverFromFile(target, file)
    await reloadWorks()
    if (editWork.value.id === target) {
      editWork.value.cover_image = works.value.find(w => w.id === target)?.cover_image ?? null
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '设置封面失败')
  } finally {
    coverBusy.value = null
  }
}

async function pickCoverForWork(workId: number) {
  coverBusy.value = workId
  try {
    const coverPath = await pickWorkCover(workId)
    if (!coverPath) return
    await reloadWorks()
    if (editWork.value.id === workId) {
      editWork.value.cover_image = coverPath
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '设置封面失败')
  } finally {
    coverBusy.value = null
  }
}

async function removeCoverForWork(workId: number) {
  if (!confirm('确定移除作品封面？')) return
  coverBusy.value = workId
  try {
    await removeWorkCover(workId)
    await reloadWorks()
    if (editWork.value.id === workId) {
      editWork.value.cover_image = null
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '移除封面失败')
  } finally {
    coverBusy.value = null
  }
}

function clearCreateCover() {
  clearPendingCover()
}

watch(viewMode, (mode) => {
  localStorage.setItem(VIEW_MODE_KEY, mode)
})

async function exportWork(workId: number, title: string) {
  backupBusy.value = workId
  try {
    const bundle = await window.anovel.invoke('backup:exportWork', workId) as object
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title}-backup.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('导出失败:', e)
    alert('导出失败')
  } finally {
    backupBusy.value = null
  }
}

async function importWorkFromFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const bundle = JSON.parse(text)
    const newId = await window.anovel.invoke('backup:importWork', bundle) as number
    works.value = await window.anovel.invoke('work:list') as Work[]
    router.push(`/work/${newId}`)
  } catch (e) {
    console.error('导入失败:', e)
    alert('导入失败，请检查文件格式')
  } finally {
    input.value = ''
  }
}

onMounted(async () => {
  try {
    await reloadWorks()
  } catch (e) {
    console.error('加载作品列表失败:', e)
  } finally {
    loading.value = false
  }
})

/** 侧栏「作品管理」在编辑页时仍高亮本路由；从文风/实验室返回时刷新列表 */
onActivated(async () => {
  try {
    await reloadWorks()
  } catch (e) {
    console.error('刷新作品列表失败:', e)
  }
})

const novelLengthOptions = computed(() =>
  (Object.keys(NOVEL_LENGTH_PRESETS) as NovelLength[]).map(key => ({
    key,
    ...NOVEL_LENGTH_PRESETS[key],
    summary: novelLengthSummary(key)
  }))
)

async function createWork() {
  if (!newWork.value.title.trim()) return
  creating.value = true
  try {
    const id = await window.anovel.invoke('work:create', {
      title: newWork.value.title.trim(),
      description: newWork.value.description.trim() || undefined,
      novelLength: newNovelLength.value
    }) as number
    if (pendingCoverFile.value) {
      try {
        await setWorkCoverFromFile(id, pendingCoverFile.value)
      } catch (e) {
        console.error('设置封面失败:', e)
        alert(e instanceof Error ? e.message : '作品已创建，但封面设置失败')
      }
    }
    showCreateDialog.value = false
    newWork.value = { title: '', description: '' }
    newNovelLength.value = DEFAULT_NOVEL_LENGTH
    clearPendingCover()
    await reloadWorks()
    router.push(`/work/${id}`)
  } catch (e) {
    console.error('创建作品失败:', e)
  } finally {
    creating.value = false
  }
}

async function deleteWork(id: number, title: string) {
  if (!confirm(`确定删除作品「${title}」吗？此操作不可撤销。`)) return
  try {
    await window.anovel.invoke('work:delete', id)
    works.value = works.value.filter(w => w.id !== id)
  } catch (e) {
    console.error('删除作品失败:', e)
  }
}

function openEditDialog(work: Work) {
  editWork.value = {
    id: work.id,
    title: work.title,
    description: work.description ?? '',
    cover_image: work.cover_image
  }
  showEditDialog.value = true
}

function closeEditDialog() {
  showEditDialog.value = false
  editWork.value = { id: 0, title: '', description: '', cover_image: null }
}

async function saveWorkEdit() {
  if (!editWork.value.title.trim() || saving.value) return
  saving.value = true
  try {
    await window.anovel.invoke('work:update', editWork.value.id, {
      title: editWork.value.title.trim(),
      description: editWork.value.description.trim() || null
    })
    await reloadWorks()
    closeEditDialog()
  } catch (e) {
    console.error('更新作品失败:', e)
    alert('保存失败，请重试')
  } finally {
    saving.value = false
  }
}

function enterWork(id: number) {
  router.push(`/work/${id}`)
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'Z')
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前'
  return d.toLocaleDateString('zh-CN')
}
</script>

<template>
  <div class="p-8 animate-fade-in">
    <!-- 头部区域 -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 border-b border-base-300/60 pb-6">
      <div>
        <h2 class="text-2xl font-extrabold tracking-tight">我的作品</h2>
        <p class="text-sm text-base-content/50 mt-1">管理并孵化你的小说创作项目，开启 AI 创作之旅</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div v-if="!loading && works.length > 0" class="join">
          <button
            type="button"
            class="btn btn-sm join-item gap-1.5"
            :class="viewMode === 'card' ? 'btn-primary' : 'btn-ghost'"
            title="卡片视图"
            @click="viewMode = 'card'"
          >
            <font-awesome-icon icon="th-large" class="w-3.5 h-3.5" />
            卡片
          </button>
          <button
            type="button"
            class="btn btn-sm join-item gap-1.5"
            :class="viewMode === 'list' ? 'btn-primary' : 'btn-ghost'"
            title="列表视图"
            @click="viewMode = 'list'"
          >
            <font-awesome-icon icon="list-ol" class="w-3.5 h-3.5" />
            列表
          </button>
        </div>
        <button type="button" @click="openCreateDialog" class="btn btn-primary gap-2">
          <font-awesome-icon icon="plus" class="w-4 h-4 mr-1.5" />
          新建作品
        </button>
        <label class="btn btn-outline gap-2 cursor-pointer">
          <font-awesome-icon icon="upload" class="w-4 h-4" />
          导入作品
          <input type="file" accept=".json,application/json" class="hidden" @change="importWorkFromFile" />
        </label>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="flex flex-col items-center justify-center py-32 text-base-content/40">
      <span class="loading loading-spinner loading-lg text-primary mb-4"></span>
      <p class="text-sm font-medium tracking-wide">正在加载作品列表...</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="works.length === 0" class="flex flex-col items-center justify-center py-24 text-center border border-dashed border-base-300 rounded-2xl bg-base-200/20">
      <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-4">
        <font-awesome-icon icon="book-open" class="text-2xl" />
      </div>
      <h3 class="text-lg font-bold">还没有任何作品</h3>
      <p class="text-sm text-base-content/50 mt-1 max-w-xs">
        点击上方按钮或下方快速开始，开启你的第一个精彩故事。
      </p>
      <button @click="openCreateDialog" class="btn btn-primary btn-sm mt-6">
        <font-awesome-icon icon="plus" class="w-3.5 h-3.5 mr-1" />
        开始创作
      </button>
    </div>

    <!-- 卡片视图 -->
    <div v-else-if="viewMode === 'card'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div
        v-for="work in works"
        :key="work.id"
        class="card bg-base-200/40 border border-base-300 hover:border-primary/40 hover:bg-base-200/80 shadow-sm hover:shadow-md
               cursor-pointer group transition-all duration-300 rounded-xl overflow-hidden"
        @click="enterWork(work.id)"
      >
        <div
          class="h-36 bg-base-300/50 overflow-hidden"
          :class="work.cover_image ? '' : 'flex items-center justify-center'"
        >
          <img
            v-if="work.cover_image"
            :src="workCoverSrc(work.cover_image)!"
            :alt="work.title"
            class="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
          <div v-else class="flex flex-col items-center text-base-content/25">
            <font-awesome-icon icon="book-open" class="text-3xl" />
            <span class="text-[10px] mt-1">暂无封面</span>
          </div>
        </div>
        <div class="card-body p-5 flex flex-col justify-between min-h-[9.5rem]">
          <div>
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="min-w-0">
                <h3 class="font-bold text-base-content leading-snug group-hover:text-primary transition-colors truncate">
                  {{ work.title }}
                </h3>
                <span class="text-xs font-bold text-base-content/30 uppercase tracking-wider">PROJECT #{{ work.id }}</span>
              </div>
            </div>
            <p class="text-xs text-base-content/60 line-clamp-2 leading-relaxed">
              {{ work.description || '暂无简介，点击进入编辑，为你的故事添加一段精彩的大纲或背景设定。' }}
            </p>
          </div>

          <div class="flex items-center justify-between mt-4 pt-3 border-t border-base-300/40">
            <span class="text-xs font-medium text-base-content/40 flex items-center gap-1.5">
              <font-awesome-icon icon="clock" class="w-3 h-3 opacity-60" />
              {{ formatDate(work.update_time) }}更新
            </span>
            <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                title="封面"
                :disabled="coverBusy === work.id"
                @click.stop="openEditDialog(work)"
              >
                <font-awesome-icon icon="palette" class="w-3 h-3 mr-1" />
                封面
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click.stop="openEditDialog(work)">
                <font-awesome-icon icon="edit" class="w-3 h-3 mr-1" />
                编辑
              </button>
              <button
                type="button"
                :disabled="backupBusy === work.id"
                class="btn btn-ghost btn-xs"
                @click.stop="exportWork(work.id, work.title)"
              >
                <font-awesome-icon icon="download" class="w-3 h-3 mr-1" />
                备份
              </button>
              <button type="button" class="btn btn-ghost btn-xs text-error" @click.stop="deleteWork(work.id, work.title)">
                <font-awesome-icon icon="trash" class="w-3 h-3 mr-1" />
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else class="border border-base-300 rounded-xl overflow-hidden bg-base-200/20">
      <div
        v-for="(work, index) in works"
        :key="work.id"
        class="flex items-center gap-4 px-4 py-3 hover:bg-base-200/70 cursor-pointer group transition-colors"
        :class="index > 0 ? 'border-t border-base-300/60' : ''"
        @click="enterWork(work.id)"
      >
        <div
          class="w-10 h-14 rounded overflow-hidden shrink-0 border border-base-300/60 bg-primary/10 flex items-center justify-center text-primary group-hover:border-primary/30 transition-colors"
        >
          <img
            v-if="work.cover_image"
            :src="workCoverSrc(work.cover_image)!"
            :alt="work.title"
            class="w-full h-full object-cover"
          />
          <font-awesome-icon v-else icon="book-open" class="text-sm" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <h3 class="font-semibold text-sm truncate group-hover:text-primary transition-colors">
              {{ work.title }}
            </h3>
            <span class="text-[10px] font-bold text-base-content/30 uppercase tracking-wider shrink-0 hidden sm:inline">
              #{{ work.id }}
            </span>
          </div>
          <p class="text-xs text-base-content/50 line-clamp-1 mt-0.5">
            {{ work.description || '暂无简介' }}
          </p>
        </div>
        <span class="text-xs text-base-content/40 shrink-0 hidden md:flex items-center gap-1.5 w-28 justify-end">
          <font-awesome-icon icon="clock" class="w-3 h-3 opacity-60" />
          {{ formatDate(work.update_time) }}
        </span>
        <div class="flex gap-0.5 shrink-0" @click.stop>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            title="封面"
            :disabled="coverBusy === work.id"
            @click="openEditDialog(work)"
          >
            <font-awesome-icon icon="palette" class="w-3 h-3" />
          </button>
          <button type="button" class="btn btn-ghost btn-xs btn-square" title="编辑" @click="openEditDialog(work)">
            <font-awesome-icon icon="edit" class="w-3 h-3" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            title="备份"
            :disabled="backupBusy === work.id"
            @click="exportWork(work.id, work.title)"
          >
            <font-awesome-icon icon="download" class="w-3 h-3" />
          </button>
          <button type="button" class="btn btn-ghost btn-xs btn-square text-error" title="删除" @click="deleteWork(work.id, work.title)">
            <font-awesome-icon icon="trash" class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>

    <!-- 新建作品弹窗 -->
    <dialog :class="['modal modal-bottom sm:modal-middle', showCreateDialog && 'modal-open']">
      <div class="modal-box border border-base-300/80 shadow-2xl p-6 rounded-2xl">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="plus" class="text-lg" />
          </div>
          <div>
            <h3 class="text-lg font-bold">新建作品</h3>
            <p class="text-xs text-base-content/50">开始孵化一个新的小说灵感</p>
          </div>
        </div>

        <div class="space-y-4">
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品标题 <span class="text-error">*</span></span>
            </div>
            <input
              v-model="newWork.title"
              placeholder="给你的故事起个响亮的名字"
              class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              @keyup.enter="createWork"
            />
          </label>
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品简介</span>
            </div>
            <textarea
              v-model="newWork.description"
              placeholder="简单描述一下你的故事背景、核心创意或主角设定..."
              rows="4"
              class="textarea textarea-bordered w-full focus:textarea-primary text-sm rounded-lg resize-none leading-relaxed"
            />
          </label>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品封面</span>
            </div>
            <div class="flex items-start gap-4">
              <div
                class="w-20 h-28 rounded-lg border border-base-300 overflow-hidden bg-base-200/60 shrink-0 flex items-center justify-center text-base-content/25"
              >
                <img
                  v-if="pendingCoverPreview"
                  :src="pendingCoverPreview"
                  alt="封面预览"
                  class="w-full h-full object-cover"
                />
                <font-awesome-icon v-else icon="book-open" class="text-xl" />
              </div>
              <div class="flex flex-wrap gap-2">
                <button type="button" class="btn btn-outline btn-sm" @click="triggerCoverPicker('create')">
                  选择封面
                </button>
                <button
                  v-if="pendingCoverPreview"
                  type="button"
                  class="btn btn-ghost btn-sm text-error"
                  @click="clearCreateCover"
                >
                  移除
                </button>
              </div>
            </div>
          </div>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">篇幅类型</span>
            </div>
            <div class="grid grid-cols-1 gap-2">
              <label
                v-for="opt in novelLengthOptions"
                :key="opt.key"
                class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                :class="newNovelLength === opt.key ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-base-content/20'"
              >
                <input
                  v-model="newNovelLength"
                  type="radio"
                  name="novelLength"
                  class="radio radio-primary radio-sm mt-0.5"
                  :value="opt.key"
                />
                <div class="min-w-0">
                  <div class="text-sm font-semibold">{{ opt.label }}</div>
                  <div class="text-xs text-base-content/50 mt-0.5">{{ opt.description }}</div>
                  <div class="text-xs text-primary/80 mt-1">建议 {{ opt.summary }}</div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="modal-action gap-2 mt-6">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreateDialog = false; clearPendingCover()">取消</button>
          <button
            type="button"
            @click="createWork"
            :disabled="!newWork.title.trim() || creating"
            class="btn btn-primary btn-sm gap-2"
          >
            <font-awesome-icon v-if="creating" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
            {{ creating ? '创建中...' : '创建作品' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/40 backdrop-blur-xs" @click="showCreateDialog = false; clearPendingCover()"></div>
    </dialog>

    <!-- 编辑作品弹窗 -->
    <dialog :class="['modal modal-bottom sm:modal-middle', showEditDialog && 'modal-open']">
      <div class="modal-box border border-base-300/80 shadow-2xl p-6 rounded-2xl">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="edit" class="text-lg" />
          </div>
          <div>
            <h3 class="text-lg font-bold">编辑作品</h3>
            <p class="text-xs text-base-content/50">修改作品名称、简介与封面</p>
          </div>
        </div>

        <div class="space-y-4">
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品标题 <span class="text-error">*</span></span>
            </div>
            <input
              v-model="editWork.title"
              placeholder="作品名称"
              class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              @keyup.enter="saveWorkEdit"
            />
          </label>
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品简介</span>
            </div>
            <textarea
              v-model="editWork.description"
              placeholder="作品简介..."
              rows="4"
              class="textarea textarea-bordered w-full focus:textarea-primary text-sm rounded-lg resize-none leading-relaxed"
            />
          </label>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品封面</span>
            </div>
            <div class="flex items-start gap-4">
              <div
                class="w-24 h-32 rounded-lg border border-base-300 overflow-hidden bg-base-200/60 shrink-0 flex items-center justify-center text-base-content/25"
              >
                <img
                  v-if="editWork.cover_image"
                  :src="workCoverSrc(editWork.cover_image)!"
                  alt="封面预览"
                  class="w-full h-full object-cover"
                />
                <font-awesome-icon v-else icon="book-open" class="text-2xl" />
              </div>
              <div class="flex flex-col gap-2">
                <button
                  type="button"
                  class="btn btn-outline btn-sm self-start"
                  :disabled="coverBusy === editWork.id"
                  @click="pickCoverForWork(editWork.id)"
                >
                  {{ editWork.cover_image ? '更换封面' : '选择封面' }}
                </button>
                <button
                  v-if="editWork.cover_image"
                  type="button"
                  class="btn btn-ghost btn-sm text-error self-start"
                  :disabled="coverBusy === editWork.id"
                  @click="removeCoverForWork(editWork.id)"
                >
                  移除封面
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-action gap-2 mt-6">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeEditDialog">取消</button>
          <button
            type="button"
            :disabled="!editWork.title.trim() || saving"
            class="btn btn-primary btn-sm gap-2"
            @click="saveWorkEdit"
          >
            <font-awesome-icon v-if="saving" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/40 backdrop-blur-xs" @click="closeEditDialog"></div>
    </dialog>

    <input
      ref="coverInputRef"
      type="file"
      :accept="WORK_COVER_ACCEPT"
      class="hidden"
      @change="handleCoverFileSelect"
    />
  </div>
</template>
