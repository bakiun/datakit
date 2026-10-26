<script setup lang="ts">
import { ref } from 'vue';
import ModalDialog, { type ActionResult } from './ModalDialog.vue';

/** Confirms a destructive change; with a `target`, the name has to be typed before the primary button works. */
defineProps<{ title: string; text: string; primary: string; action: () => Promise<ActionResult>; target?: string | null; disabled?: boolean }>();
defineEmits<{ close: [] }>();

const typed = ref('');
</script>

<template>
  <ModalDialog :title="title" :primary="primary" danger :disabled="disabled || (!!target && typed !== target)" :action="action" @close="$emit('close')">
    <p class="text">{{ text }}</p>
    <slot />
    <label v-if="target" class="confirm">
      <span>Type <span class="mono target">{{ target }}</span> to confirm</span>
      <input v-model="typed" class="fld mono" aria-label="Type the name to confirm" spellcheck="false" autocomplete="off" />
    </label>
  </ModalDialog>
</template>

<style scoped>
.text {
  margin: 0;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.confirm {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.target {
  color: var(--vscode-foreground);
  overflow-wrap: anywhere;
}
</style>
