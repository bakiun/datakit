<script setup lang="ts">
import { ref } from 'vue';
import KafkaDialog from './KafkaDialog.vue';
import type { WriteResult } from './workspace';

/** Confirms a destructive write; with a `target`, the name has to be typed before the primary button works. */
defineProps<{ title: string; text: string; primary: string; action: () => Promise<WriteResult>; target?: string | null }>();
defineEmits<{ close: [] }>();

const typed = ref('');
</script>

<template>
  <KafkaDialog :title="title" :primary="primary" danger :disabled="!!target && typed !== target" :action="action" @close="$emit('close')">
    <p class="text">{{ text }}</p>
    <slot />
    <label v-if="target" class="field confirm">
      <span>Type <span class="mono target">{{ target }}</span> to confirm</span>
      <input v-model="typed" class="fld mono" aria-label="Type the name to confirm" spellcheck="false" autocomplete="off" />
    </label>
  </KafkaDialog>
</template>

<style scoped>
.text {
  margin: 0;
  line-height: 1.5;
}
.confirm {
  color: var(--vscode-descriptionForeground);
}
.target {
  color: var(--vscode-foreground);
  overflow-wrap: anywhere;
}
</style>
