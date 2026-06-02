<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../utils/renderMarkdown'

const props = withDefaults(
  defineProps<{
    content: string
    size?: 'xs' | 'sm'
    inheritColor?: boolean
  }>(),
  { size: 'sm', inheritColor: false }
)

const renderedHtml = computed(() => renderMarkdown(props.content))
</script>

<template>
  <div
    :class="[
      'markdown-content leading-relaxed',
      inheritColor ? 'inherit-color text-current' : 'text-base-content/70',
      size === 'xs' ? 'text-xs' : 'text-sm'
    ]"
    v-html="renderedHtml"
  />
</template>

<style scoped>
.markdown-content :deep(:first-child) {
  margin-top: 0;
}

.markdown-content :deep(:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4) {
  font-weight: 600;
  color: oklch(var(--bc) / 0.85);
  margin: 1em 0 0.5em;
}

.markdown-content.inherit-color :deep(h1),
.markdown-content.inherit-color :deep(h2),
.markdown-content.inherit-color :deep(h3),
.markdown-content.inherit-color :deep(h4),
.markdown-content.inherit-color :deep(p),
.markdown-content.inherit-color :deep(li),
.markdown-content.inherit-color :deep(blockquote),
.markdown-content.inherit-color :deep(a) {
  color: inherit;
}

.markdown-content :deep(h1) { font-size: 1.25rem; }
.markdown-content :deep(h2) { font-size: 1.125rem; }
.markdown-content :deep(h3) { font-size: 1rem; }
.markdown-content :deep(h4) { font-size: 0.875rem; }

.markdown-content :deep(p),
.markdown-content :deep(ul),
.markdown-content :deep(ol),
.markdown-content :deep(pre),
.markdown-content :deep(blockquote),
.markdown-content :deep(table) {
  margin: 0.5em 0;
}

.markdown-content :deep(ul) {
  list-style-type: disc;
  padding-left: 1.25rem;
}

.markdown-content :deep(ol) {
  list-style-type: decimal;
  padding-left: 1.25rem;
}

.markdown-content :deep(li) {
  margin: 0.25em 0;
}

.markdown-content :deep(code) {
  font-family: ui-monospace, monospace;
  font-size: 0.875em;
  background: oklch(var(--b3));
  padding: 0.125em 0.375em;
  border-radius: 0.25rem;
}

.markdown-content :deep(pre) {
  background: oklch(var(--b3));
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow-x: auto;
}

.markdown-content :deep(pre code) {
  background: none;
  padding: 0;
}

.markdown-content :deep(blockquote) {
  border-left: 3px solid oklch(var(--p));
  padding-left: 0.75rem;
  opacity: 0.85;
}

.markdown-content :deep(a) {
  color: oklch(var(--p));
  text-decoration: underline;
}

.markdown-content :deep(table) {
  width: 100%;
  border-collapse: collapse;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  border: 1px solid oklch(var(--b3));
  padding: 0.375rem 0.5rem;
}

.markdown-content :deep(th) {
  font-weight: 600;
  background: oklch(var(--b2));
}
</style>
