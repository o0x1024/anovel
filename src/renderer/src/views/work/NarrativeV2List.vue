<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

interface NarrativeNovel {
  id: number
  title: string
  revision: number
  chapterCount: number
}

const router = useRouter()
const novels = ref<NarrativeNovel[]>([])
const title = ref('')
const loading = ref(false)
const creating = ref(false)
const error = ref('')

async function reload(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    await window.anovel.invoke('narrativeV2:getGlobalModel')
    novels.value = await window.anovel.invoke('narrativeV2:listNovels') as NarrativeNovel[]
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}

async function createNovel(): Promise<void> {
  if (!title.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    const novel = await window.anovel.invoke('narrativeV2:createNovel', title.value.trim()) as NarrativeNovel
    title.value = ''
    await router.push(`/novel/${novel.id}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    creating.value = false
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="p-8 max-w-7xl mx-auto space-y-6 animate-fade-in">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b border-base-300 pb-5">
      <div>
        <div class="flex items-center gap-2 text-primary font-semibold text-sm">
          <font-awesome-icon icon="project-diagram" /> Narrative V2
        </div>
        <h2 class="text-3xl font-extrabold tracking-tight mt-1">小说管理</h2>
        <p class="text-sm text-base-content/55 mt-2">新建或选择一本小说，进入后使用 V2 自动化生成引擎。</p>
      </div>
      <button class="btn btn-outline btn-sm" :disabled="loading" @click="reload">
        <font-awesome-icon icon="sync" :class="{ 'animate-spin': loading }" /> 刷新
      </button>
    </header>

    <div v-if="error" class="alert alert-error"><span>{{ error }}</span></div>

    <section class="card bg-base-200 border border-base-300 shadow-sm">
      <div class="card-body p-5">
        <h3 class="font-bold">新建小说</h3>
        <div class="join w-full max-w-xl mt-2">
          <input v-model="title" class="input input-bordered join-item w-full" placeholder="小说标题" :disabled="creating" @keyup.enter="createNovel">
          <button class="btn btn-primary join-item" :disabled="!title.trim() || creating" @click="createNovel">新建并进入</button>
        </div>
      </div>
    </section>

    <section>
      <div class="flex items-center justify-between mb-3"><h3 class="text-lg font-bold">我的小说</h3><span class="text-sm text-base-content/55">{{ novels.length }} 本</span></div>
      <div v-if="!loading && !novels.length" class="rounded-xl border border-dashed border-base-300 py-16 text-center text-base-content/50">还没有小说，先新建一本开始创作。</div>
      <div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        <button v-for="novel in novels" :key="novel.id" class="card bg-base-200 border border-base-300 text-left shadow-sm hover:border-primary/60 hover:shadow-md transition-all" @click="router.push(`/novel/${novel.id}`)">
          <div class="card-body p-5">
            <h4 class="font-bold text-lg truncate">{{ novel.title }}</h4>
            <p class="text-sm text-base-content/55 mt-3">{{ novel.chapterCount }} 个已提交章节 · 权威状态 r{{ novel.revision }}</p>
            <div class="text-primary text-sm font-semibold mt-4">进入小说 <font-awesome-icon icon="arrow-right" /></div>
          </div>
        </button>
      </div>
    </section>
  </div>
</template>
