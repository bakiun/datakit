<script setup lang="ts">
import type { RedisEdit, RedisKeyDetail } from '@datakit/core';
import { ref, type Directive } from 'vue';
import Icon from '../components/Icon.vue';
import { formatBytes, longTtl, textOf } from './format';
import TypeBadge from './TypeBadge.vue';

/** The key above its value: click the name to rename it (RENAME) or the TTL to change it (EXPIRE, PERSIST). */
const props = defineProps<{ detail: RedisKeyDetail; readOnly: boolean }>();
const emit = defineEmits<{ edit: [edit: RedisEdit] }>();

const editing = ref<'name' | 'ttl' | null>(null);
const draft = ref('');
const vFocus: Directive<HTMLInputElement> = { mounted: (el) => (el.focus(), el.select()) };

function start(what: 'name' | 'ttl'): void {
  if (props.readOnly) return;
  editing.value = what;
  draft.value = what === 'name' ? textOf(props.detail.key) : props.detail.ttl === null ? '' : String(props.detail.ttl);
}

function commit(): void {
  const what = editing.value;
  editing.value = null;
  const value = draft.value.trim();
  if (what === 'name' && value && value !== textOf(props.detail.key)) emit('edit', { kind: 'renameKey', key: props.detail.key, to: value });
  if (what === 'ttl') {
    const ttl = value === '' ? null : Number(value.replace(/[^0-9]/g, ''));
    if (ttl !== props.detail.ttl) emit('edit', { kind: 'expire', key: props.detail.key, ttl });
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter') commit();
  if (event.key === 'Escape') editing.value = null;
}
</script>

<template>
  <div class="key-header">
    <TypeBadge :type="detail.type" />
    <input v-if="editing === 'name'" v-model="draft" v-focus class="fld mono name-input" aria-label="Key name" @keydown="onKey" @blur="commit" />
    <button v-else type="button" class="name mono" :title="readOnly ? textOf(detail.key) : 'Click to rename'" @click="start('name')">
      {{ textOf(detail.key) }}
    </button>
    <span class="fact">
      TTL
      <input
        v-if="editing === 'ttl'"
        v-model="draft"
        v-focus
        class="fld mono ttl-input"
        aria-label="TTL in seconds"
        placeholder="seconds, empty = no expiry"
        @keydown="onKey"
        @blur="commit"
      />
      <button v-else type="button" class="value mono" :class="{ expires: detail.ttl !== null }" :title="readOnly ? '' : 'Click to change'" @click="start('ttl')">
        {{ longTtl(detail.ttl) }}
      </button>
    </span>
    <span class="fact">Size <span class="value mono">{{ formatBytes(detail.size) }}</span></span>
    <span v-if="detail.encoding" class="fact">Encoding <span class="value mono">{{ detail.encoding }}</span></span>
    <button
      type="button"
      class="btn small danger"
      :disabled="readOnly"
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
  width: 190px;
  height: 24px;
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
