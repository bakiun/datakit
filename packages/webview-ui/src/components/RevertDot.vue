<script setup lang="ts">
import Icon from './Icon.vue';

/**
 * A small button at the right edge of a cell that has an edit not written yet; a click takes the edit back. Its
 * background is opaque, so it stays readable over the cell's text.
 */
withDefaults(defineProps<{ label: string; title?: string; tone?: 'changed' | 'added' }>(), { title: 'Revert this change', tone: 'changed' });
defineEmits<{ click: [] }>();
</script>

<template>
  <button type="button" class="revert-dot" :class="tone" :title="title" :aria-label="label" @click.stop="$emit('click')">
    <Icon name="revert" :size="11" />
  </button>
</template>

<style scoped>
.revert-dot {
  position: absolute;
  top: 50%;
  right: 3px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid var(--vscode-editor-background);
  border-radius: 3px;
  background: var(--vscode-gitDecoration-modifiedResourceForeground);
  color: var(--vscode-editor-background);
  transform: translateY(-50%);
  cursor: pointer;
}
.revert-dot.added {
  background: var(--vscode-gitDecoration-addedResourceForeground);
}
/* The icon is drawn for 16 px; at 11 px its strokes need more weight to stay visible. */
.revert-dot :deep(.icon) {
  stroke-width: 2.6;
}
.revert-dot:hover {
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}
.revert-dot:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}
</style>
