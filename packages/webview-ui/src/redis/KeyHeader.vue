<script setup lang="ts">
import { editProblem, type RedisEdit, type RedisKeyDetail } from '@datakit/core';
import { ref, watch, type Directive } from 'vue';
import Icon from '../components/Icon.vue';
import { formatBytes, longTtl, parseTtl, textOf } from './format';
import TypeBadge from './TypeBadge.vue';

/**
 * The key above its value: click the name to rename it (RENAME) or the TTL to change it (EXPIRE, PERSIST). A TTL
 * that cannot be read keeps its editor open with the reason.
 */
const props = defineProps<{ detail: RedisKeyDetail; readOnly: boolean }>();
/** `dismiss`: an editor was closed with Esc, so a message about its last write is no longer current. */
const emit = defineEmits<{ edit: [edit: RedisEdit]; dismiss: [] }>();

const READ_ONLY = 'The data source is read-only';
const editing = ref<'name' | 'ttl' | null>(null);
const draft = ref('');
const problem = ref<string | null>(null);
const vFocus: Directive<HTMLInputElement> = { mounted: (el) => (el.focus(), el.select()) };
watch(draft, () => (problem.value = null));

function start(what: 'name' | 'ttl', text?: string): void {
  if (props.readOnly) return;
  editing.value = what;
  draft.value = text ?? (what === 'name' ? textOf(props.detail.key) : props.detail.ttl === null ? '' : String(props.detail.ttl));
  problem.value = null;
}

function commit(): void {
  const what = editing.value;
  const value = draft.value.trim();
  let edit: RedisEdit | null = null;
  if (what === 'name' && value && value !== textOf(props.detail.key)) edit = { kind: 'renameKey', key: props.detail.key, to: value };
  if (what === 'ttl') {
    const ttl = parseTtl(value);
    if (ttl !== props.detail.ttl) edit = { kind: 'expire', key: props.detail.key, ttl };
  }
  problem.value = edit && editProblem(edit);
  if (problem.value) return;
  editing.value = null;
  if (edit) emit('edit', edit);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') commit();
  if (event.key === 'Escape') {
    editing.value = null;
    emit('dismiss');
  }
}

/** Opens the editor again with an edit that was not written, e.g. a rename to a name that is taken. */
function restore(edit: RedisEdit): boolean {
  if (edit.kind === 'renameKey') start('name', edit.to);
  else if (edit.kind === 'expire') start('ttl', edit.ttl === null ? '' : String(edit.ttl));
  else return false;
  return true;
}
defineExpose({ restore });
</script>

<template>
  <div class="key-header">
    <TypeBadge :type="detail.type" />
    <input v-if="editing === 'name'" v-model="draft" v-focus class="fld mono name-input" aria-label="Key name" @keydown="onKey" @blur="commit" />
    <button v-else type="button" class="name mono" :title="readOnly ? textOf(detail.key) : `${textOf(detail.key)} · click to rename`" @click="start('name')">
      {{ textOf(detail.key) }}
    </button>
    <span class="fact">
      TTL
      <input
        v-if="editing === 'ttl'"
        v-model="draft"
        v-focus
        class="fld mono ttl-input"
        :class="{ invalid: problem }"
        aria-label="TTL in seconds"
        :aria-invalid="!!problem"
        :title="problem ?? 'Seconds, or e.g. 30m, 2h, 1d; empty = no expiry'"
        placeholder="e.g. 3600, 30m, 2h; empty = no expiry"
        @keydown="onKey"
        @blur="commit"
      />
      <button v-else type="button" class="value mono" :class="{ expires: detail.ttl !== null }" :title="readOnly ? READ_ONLY : 'Click to change'" @click="start('ttl')">
        {{ longTtl(detail.ttl) }}
      </button>
      <span v-if="problem" class="problem" role="alert">{{ problem }}</span>
    </span>
    <span class="fact">Size <span class="value mono">{{ formatBytes(detail.size) }}</span></span>
    <span v-if="detail.encoding" class="fact">Encoding <span class="value mono">{{ detail.encoding }}</span></span>
    <button
      type="button"
      class="btn small danger"
      :disabled="readOnly"
      :title="readOnly ? READ_ONLY : undefined"
      @click="emit('edit', { kind: 'deleteKeys', keys: [detail.key] })"
    >
      <Icon name="trash" :size="14" /> Delete key
    </button>
  </div>
</template>

<style scoped>
.key-header {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  padding: 8px 12px;
}
.name {
  min-width: 0;
  max-width: 50%;
  overflow: hidden;
  padding: 2px 4px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-foreground);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: text;
}
.name:hover,
.value:is(button):hover {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
.name-input {
  flex: 0 1 320px;
}
.fact {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.value {
  padding: 2px 4px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--vscode-foreground);
}
button.value {
  cursor: text;
}
.value.expires {
  color: var(--vscode-editorWarning-foreground);
}
.ttl-input {
  width: 220px;
  height: 24px;
}
.ttl-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
.problem {
  color: var(--vscode-errorForeground);
}
.btn.small {
  height: 24px;
  margin-left: auto;
  padding: 0 10px;
  font-size: 12px;
}
.btn.danger:not(:disabled) {
  color: var(--vscode-errorForeground);
}
</style>
