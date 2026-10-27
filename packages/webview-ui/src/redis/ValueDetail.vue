<script setup lang="ts">
import type { RedisText } from '@datakit/core';
import { computed } from 'vue';
import CodeView from '../components/CodeView.vue';
import IconButton from '../components/IconButton.vue';
import { describeValue, textOf } from './format';

/**
 * The value of the picked item in full; JSON is shown parsed and indented unless “Text” is picked. `raw`, the “Text”
 * choice, is shared with the string editor, so it stays from key to key.
 */
const props = defineProps<{ label: string; value: RedisText }>();
defineEmits<{ copy: [text: string] }>();
const raw = defineModel<boolean>('raw', { required: true });

const view = computed({
  get: (): 'auto' | 'text' => (raw.value ? 'text' : 'auto'),
  set: (next) => (raw.value = next === 'text'),
});
const info = computed(() => describeValue(props.value));
const parsed = computed(() => view.value === 'auto' && info.value.json !== undefined);
const text = computed(() => (parsed.value ? JSON.stringify(info.value.json, null, 2) : textOf(props.value)));
</script>

<template>
  <section class="detail" aria-label="Item detail">
    <div class="bar">
      <span class="title">Row detail</span>
      <span class="label mono">{{ label }}</span>
      <span class="kind">{{ info.kind }}</span>
      <label class="view">
        View as
        <select v-model="view" class="sel" aria-label="View as">
          <option value="auto">Auto (parsed)</option>
          <option value="text">Text</option>
        </select>
      </label>
      <IconButton icon="copy" label="Copy the value" @click="$emit('copy', textOf(value))" />
    </div>
    <div class="body">
      <CodeView :model-value="text" :language="parsed ? 'json' : 'text'" read-only label="Item value" />
    </div>
  </section>
</template>

<style scoped>
.detail {
  flex: none;
  display: flex;
  flex-direction: column;
  height: 170px;
  margin: 8px 12px 0;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  overflow: hidden;
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 4px 2px 10px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
  font-size: 12px;
}
.title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.label {
  color: var(--vscode-textLink-foreground);
}
.kind {
  color: var(--vscode-descriptionForeground);
}
.view {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-descriptionForeground);
}
.sel {
  height: 24px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
}
.body {
  flex: 1;
  min-height: 0;
}
</style>
