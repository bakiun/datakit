<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

export interface CliEntry {
  line: string;
  output: string;
  ok: boolean;
  /** Edits made in the browser are echoed here as the commands they sent. */
  echo: boolean;
  durationMs: number | null;
}

/** A redis-cli style prompt under the browser; ↑ and ↓ walk through earlier lines. */
const props = defineProps<{ prompt: string; entries: CliEntry[]; busy: boolean }>();
const emit = defineEmits<{ run: [line: string] }>();

const line = ref('');
const history: string[] = [];
let back = -1;
const log = ref<HTMLElement>();

watch(
  () => props.entries.length,
  () => void nextTick(() => log.value?.scrollTo({ top: log.value.scrollHeight })),
);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && line.value.trim()) {
    history.unshift(line.value);
    back = -1;
    emit('run', line.value);
    line.value = '';
  } else if (event.key === 'ArrowUp' && history.length) {
    back = Math.min(back + 1, history.length - 1);
    line.value = history[back]!;
    event.preventDefault();
  } else if (event.key === 'ArrowDown') {
    back = Math.max(back - 1, -1);
    line.value = back < 0 ? '' : history[back]!;
    event.preventDefault();
  }
}
</script>

<template>
  <section class="cli mono" aria-label="Redis CLI">
    <div ref="log" class="log" role="log">
      <div v-for="(e, i) in entries" :key="i" class="entry">
        <div><span class="prompt">{{ prompt }}&gt;</span> {{ e.line }}</div>
        <pre class="output" :class="{ error: !e.ok, echo: e.echo }">{{ e.output }}</pre>
      </div>
    </div>
    <label class="input">
      <span class="prompt">{{ prompt }}&gt;</span>
      <input v-model="line" :disabled="busy" placeholder="Type a command, e.g. TTL key" spellcheck="false" autocomplete="off" aria-label="Redis command" @keydown="onKey" />
    </label>
  </section>
</template>

<style scoped>
.cli {
  flex: none;
  display: flex;
  flex-direction: column;
  max-height: 180px;
  border-top: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}
.log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 12px 0;
}
.entry + .entry {
  margin-top: 4px;
}
.prompt {
  color: var(--vscode-terminal-ansiRed, var(--vscode-errorForeground));
}
.output {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vscode-testing-iconPassed);
}
.output.echo {
  color: var(--vscode-descriptionForeground);
}
.output.error {
  color: var(--vscode-errorForeground);
}
.input {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 8px;
}
.input input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
}
.input input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
</style>
