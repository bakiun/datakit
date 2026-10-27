<script setup lang="ts">
import { computed, ref } from 'vue';
import KafkaDialog from './KafkaDialog.vue';
import { useWorkspace, type WriteResult } from './workspace';

/**
 * Confirms a destructive write with one click on `primary`, which names the action. On a Production data source a
 * `target` name has to be typed first. Without `text`, the slot says what happens.
 */
const props = defineProps<{ title: string; text?: string; primary: string; action: () => Promise<WriteResult>; target?: string | null }>();
const emit = defineEmits<{ close: [] }>();
const ws = useWorkspace();

const typed = ref('');
const askName = computed(() => !!props.target && ws.state.init?.environment === 'production');

/** Declining VS Code's Production confirmation ends the action too, so the dialog closes. */
async function run(): Promise<WriteResult> {
  const result = await props.action();
  if (result.cancelled) emit('close');
  return result;
}
</script>

<template>
  <KafkaDialog :title="title" :primary="primary" danger :disabled="askName && typed !== target" :action="run" @close="emit('close')">
    <p v-if="text" class="text">{{ text }}</p>
    <slot />
    <label v-if="askName" class="field confirm">
      <span>Production: type <span class="mono target">{{ target }}</span> to confirm</span>
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
