import { ref, computed, watch, reactive, type MaybeRefOrGetter, toValue } from 'vue'

export function useListSelection<T>(
  items: MaybeRefOrGetter<T[]>,
  options?: {
    getKey?: (item: T, index: number) => number | string
    canSelect?: (item: T) => boolean
  }
) {
  const getKey =
    options?.getKey ??
    ((item: T, index: number) => {
      if (item && typeof item === 'object' && 'id' in item) {
        const id = (item as { id: unknown }).id
        if (typeof id === 'number') return id
      }
      return index
    })

  const canSelect = options?.canSelect ?? (() => true)
  const selectedKeys = ref<Set<number | string>>(new Set())

  const list = computed(() => toValue(items))

  const selectableItems = computed(() =>
    list.value.filter((item, index) => canSelect(item) && getKey(item, index) != null)
  )

  watch(list, () => {
    const valid = new Set<number | string>()
    for (const [index, item] of list.value.entries()) {
      if (!canSelect(item)) continue
      const key = getKey(item, index)
      if (selectedKeys.value.has(key)) valid.add(key)
    }
    selectedKeys.value = valid
  })

  function keyOf(item: T, index: number): number | string {
    return getKey(item, index)
  }

  function isSelected(item: T, index: number): boolean {
    return canSelect(item) && selectedKeys.value.has(keyOf(item, index))
  }

  function toggle(item: T, index: number) {
    if (!canSelect(item)) return
    const key = keyOf(item, index)
    const next = new Set(selectedKeys.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selectedKeys.value = next
  }

  function toggleAll() {
    if (allSelected.value) {
      selectedKeys.value = new Set()
      return
    }
    selectedKeys.value = new Set(
      list.value
        .map((item, index) => (canSelect(item) ? keyOf(item, index) : null))
        .filter((k): k is number | string => k != null)
    )
  }

  function clearSelection() {
    selectedKeys.value = new Set()
  }

  const selectedCount = computed(() => selectedKeys.value.size)

  const allSelected = computed(
    () =>
      selectableItems.value.length > 0 &&
      selectableItems.value.every((item) => {
        const index = list.value.indexOf(item)
        return selectedKeys.value.has(keyOf(item, index))
      })
  )

  function getSelectedItems(): T[] {
    return list.value.filter((item, index) => isSelected(item, index))
  }

  return reactive({
    selectedKeys,
    selectedCount,
    allSelected,
    selectableCount: computed(() => selectableItems.value.length),
    isSelected,
    toggle,
    toggleAll,
    clearSelection,
    getSelectedItems,
    canSelect
  })
}

export async function confirmBatchDelete(count: number, label: string): Promise<boolean> {
  if (count <= 0) return false
  return confirm(`确定删除选中的 ${count} 条${label}？`)
}

export async function confirmDeleteAll(count: number, label: string): Promise<boolean> {
  if (count <= 0) return false
  return confirm(`确定删除全部 ${count} 条${label}？此操作不可恢复。`)
}

export async function runBatchDelete<T>(
  items: T[],
  deleteOne: (item: T) => Promise<void>
): Promise<void> {
  for (const item of items) {
    await deleteOne(item)
  }
}
