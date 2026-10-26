<script setup lang="ts">
import Icon from './Icon.vue';
import type { IconName } from './icons';

/** A toolbar button that shows only an icon; `label` is its accessible name and tooltip. */
withDefaults(defineProps<{ icon: IconName; label: string; disabled?: boolean; filled?: boolean; tone?: 'ok' | 'danger' }>(), {});
defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button
    type="button"
    class="icon-btn toolbar-btn"
    :class="tone"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <Icon :name="icon" :size="filled ? 14 : 16" :filled="filled" />
  </button>
</template>

<style scoped>
.toolbar-btn {
  width: 28px;
  height: 28px;
}
.toolbar-btn:disabled {
  opacity: 0.35;
  cursor: default;
  background: transparent;
}
.ok {
  color: var(--vscode-testing-iconPassed);
}
.danger {
  color: var(--vscode-errorForeground);
}
</style>
