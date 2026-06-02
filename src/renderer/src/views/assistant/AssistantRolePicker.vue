<script setup lang="ts">
import { computed } from 'vue'

export interface AssistantRoleOption {
  id: number
  name: string
  icon: string
  is_builtin?: number
}

const props = defineProps<{
  roles: AssistantRoleOption[]
  disabled?: boolean
}>()

const model = defineModel<number | null>({ required: true })

const emit = defineEmits<{
  manageRoles: []
}>()

const currentRole = computed(() =>
  props.roles.find(r => r.id === model.value) ?? null
)

function selectRole(roleId: number | null, event: Event) {
  model.value = roleId
  closeDropdown(event)
}

function openManageRoles(event: Event) {
  closeDropdown(event)
  emit('manageRoles')
}

function closeDropdown(event: Event) {
  const root = (event.currentTarget as HTMLElement).closest('.dropdown')
  const trigger = root?.querySelector('[tabindex="0"]') as HTMLElement | null
  trigger?.blur()
}
</script>

<template>
  <div class="dropdown dropdown-end">
    <label
      tabindex="0"
      class="btn btn-ghost btn-sm h-8 min-h-8 px-2.5 gap-1.5 border border-base-300/80 bg-base-100/80 max-w-[200px]"
      :class="{ 'opacity-60 pointer-events-none': disabled || !roles.length }"
    >
      <font-awesome-icon :icon="currentRole?.icon || 'robot'" class="w-3.5 h-3.5 opacity-70 shrink-0" />
      <span class="text-xs truncate">{{ currentRole?.name ?? '无角色' }}</span>
      <font-awesome-icon icon="chevron-down" class="w-2.5 h-2.5 opacity-50 shrink-0" />
    </label>

    <div
      tabindex="0"
      class="dropdown-content z-30 w-72 p-0 shadow-lg border border-base-300 bg-base-100 rounded-box mt-1 overflow-hidden"
    >
      <p class="px-3 py-2 text-[11px] text-base-content/40 border-b border-base-300/60">可用角色</p>

      <ul class="menu menu-sm p-1 max-h-64 overflow-y-auto">
        <li>
          <button
            type="button"
            class="gap-2"
            :class="{ active: model === null }"
            @click="selectRole(null, $event)"
          >
            <font-awesome-icon icon="user" class="w-3.5 h-3.5 opacity-70 shrink-0" />
            <span class="flex-1 truncate text-left">无角色</span>
          </button>
        </li>
        <li v-for="role in roles" :key="role.id">
          <button
            type="button"
            class="gap-2"
            :class="{ active: role.id === model }"
            @click="selectRole(role.id, $event)"
          >
            <font-awesome-icon :icon="role.icon" class="w-3.5 h-3.5 opacity-70 shrink-0" />
            <span class="flex-1 truncate text-left">{{ role.name }}</span>
            <span v-if="role.is_builtin" class="badge badge-primary badge-xs shrink-0">内置</span>
          </button>
        </li>
        <li v-if="!roles.length" class="disabled">
          <span class="text-xs text-base-content/40 px-3 py-2">暂无角色</span>
        </li>
      </ul>

      <div class="border-t border-base-300/60 p-1">
        <button
          type="button"
          class="btn btn-ghost btn-sm w-full justify-start gap-2 text-primary"
          @click="openManageRoles($event)"
        >
          <font-awesome-icon icon="cog" class="w-3.5 h-3.5" />
          管理角色
        </button>
      </div>
    </div>
  </div>
</template>
