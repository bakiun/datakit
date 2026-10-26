<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import type { ShellEntry } from './collection';
import { num } from './format';
import ShellText from './ShellText.vue';

/**
 * A mongosh-style prompt under the tabs: `<database>>`, ↑ and ↓ walk through earlier lines, answers print below
 * the line, errors in the error color. The bar folds it away; the page sizes it with a handle above it.
 */
const props = defineProps<{ entries: ShellEntry[]; busy: boolean; database: string; collection: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ run: [line: string]; clear: [] }>();

/** Longer answers are cut so the log stays small; Copy in the shell is the way to more. */
const MAX_OUTPUT = 20_000;
const line = ref('');
const sent = ref('');
const history: string[] = [];
let back = -1;
const log = ref<HTMLElement>();
const input = ref<HTMLInputElement>();

const placeholder = computed(() => `db.${props.collection}.find({ status: "paid" })`);

const scrollDown = () => void nextTick(() => log.value?.scrollTo({ top: log.value.scrollHeight }));
watch(() => [props.entries.length, props.busy], scrollDown);
watch(open, (isOpen) => {
  if (!isOpen) return;
  scrollDown();
  void nextTick(() => input.value?.focus());
});

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && line.value.trim() && !props.busy) {
    if (history[0] !== line.value) history.unshift(line.value);
    back = -1;
    sent.value = line.value;
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

const cut = (text: string) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${num(text.length - MAX_OUTPUT)} more characters)` : text);
</script>

<template>
  <section class="mongo-shell" :class="{ open }" aria-label="MongoDB shell">
    <div class="bar">
      <button type="button" class="toggle" :aria-expanded="open" @click="open = !open">
        <Icon :name="open ? 'down' : 'up'" :size="14" />
        <span class="caps">Shell</span>
      </button>
      <span class="mono where">{{ database }}</span>
      <span v-if="busy" class="note">Running…</span>
      <span class="spacer" />
      <IconButton v-if="open && entries.length" icon="clear" label="Clear the shell output" class="small" @click="emit('clear')" />
    </div>
    <template v-if="open">
      <div ref="log" class="log mono" role="log">
        <p v-if="!entries.length && !busy" class="intro">
          Runs one mongosh line at a time in <span class="db">{{ database }}</span>, e.g. <span class="example">db.{{ collection }}.countDocuments({})</span> or
          <span class="example">use admin</span>. Lines that may write ask first on production data sources.
        </p>
        <div v-for="(e, i) in entries" :key="i" class="entry">
          <div class="echo">
            <span><span class="prompt">{{ e.database }}&gt;</span> {{ e.line }}</span>
            <span class="took">{{ e.durationMs < 10 ? e.durationMs.toFixed(1) : num(Math.round(e.durationMs)) }} ms</span>
          </div>
          <pre v-if="e.ok && e.output" class="output"><ShellText :text="cut(e.output)" /></pre>
          <pre v-else-if="e.output" class="output error">{{ cut(e.output) }}</pre>
        </div>
        <div v-if="busy" class="entry">
          <div class="echo"><span class="prompt">{{ database }}&gt;</span> {{ sent }}</div>
        </div>
      </div>
      <label class="input mono">
        <span class="prompt">{{ database }}&gt;</span>
        <input
          ref="input"
          v-model="line"
          :placeholder="placeholder"
          spellcheck="false"
          autocomplete="off"
          aria-label="Shell line"
          @keydown="onKey"
        />
      </label>
    </template>
  </section>
</template>

<style scoped>
.mongo-shell {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--m-border);
  background: var(--vscode-panel-background, var(--vscode-editor-background));
}
.bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 28px;
  padding: 0 6px 0 4px;
}
.open .bar {
  border-bottom: 1px solid var(--m-border);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
}
.toggle:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.toggle:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}
.where {
  color: var(--m-muted);
}
.spacer {
  flex: 1;
}
.small {
  width: 24px;
  height: 24px;
}
.log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 12px 0;
  line-height: 18px;
}
.intro {
  margin: 0 0 6px;
  font-family: var(--vscode-font-family);
  color: var(--m-muted);
}
.db,
.example {
  font-family: var(--vscode-editor-font-family);
  color: var(--vscode-foreground);
}
.entry + .entry {
  margin-top: 6px;
}
.prompt {
  color: var(--vscode-terminal-ansiGreen, var(--m-ok));
}
.output {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.output.error {
  color: var(--m-error);
}
.echo {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.echo > span:first-child {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.took {
  flex: none;
  font-size: 11px;
  color: var(--m-muted);
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
