<script setup lang="ts">
import type { RedisKeyInfo, RedisText } from '@datakit/core';
import { keyId, shortTtl, textOf } from './format';
import TypeBadge from './TypeBadge.vue';

/**
 * The keys found by SCAN so far; more come from the next cursor. ↑ and ↓ move to the previous or next key.
 * `filtered` when a pattern or type narrows the list, so an empty list offers to show every key.
 */
const props = defineProps<{
  keys: RedisKeyInfo[];
  selected: RedisText | null;
  total: number;
  cursor: string;
  scanning: boolean;
  error: string | null;
  filtered: boolean;
  canCreate: boolean;
}>();
const emit = defineEmits<{ pick: [key: RedisText]; more: []; retry: []; showAll: []; create: [] }>();

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.item')];
  const from = items.indexOf(document.activeElement as HTMLElement);
  const to = Math.min(Math.max(from + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1);
  const key = props.keys[to];
  if (from < 0 || to === from || !key) return;
  event.preventDefault();
  items[to]!.focus();
  emit('pick', key.key);
}
</script>

<template>
  <div class="key-list">
    <div class="head">
      <span class="type">Type</span>
      <span class="name">Key · {{ keys.length.toLocaleString('en-US') }} of {{ total.toLocaleString('en-US') }}</span>
      <span class="ttl">TTL</span>
    </div>
    <div class="items" role="listbox" aria-label="Keys" @keydown="onKey">
      <button
        v-for="k in keys"
        :key="keyId(k.key)"
        type="button"
        role="option"
        class="item"
        :aria-selected="selected !== null && keyId(selected) === keyId(k.key)"
        :title="textOf(k.key)"
        @click="$emit('pick', k.key)"
      >
        <TypeBadge :type="k.type" />
        <span class="name mono" :class="{ binary: typeof k.key !== 'string' }">{{ textOf(k.key) }}</span>
        <span class="ttl mono" :class="{ none: k.ttl === null }">{{ shortTtl(k.ttl) }}</span>
      </button>
      <p v-if="error" class="message error" role="alert">
        {{ error }} <button type="button" class="link" @click="$emit('retry')">Try again</button>
      </p>
      <p v-else-if="!keys.length && !scanning && cursor !== '0'" class="message">No keys found yet; load more to keep scanning.</p>
      <p v-else-if="!keys.length && !scanning && filtered" class="message">
        No keys match. <button type="button" class="link" @click="$emit('showAll')">Show all keys</button>
      </p>
      <p v-else-if="!keys.length && !scanning" class="message">
        This database has no keys.
        <button v-if="canCreate" type="button" class="link" @click="$emit('create')">Create one</button>
      </p>
      <button v-if="cursor !== '0'" type="button" class="btn more" :disabled="scanning" @click="$emit('more')">
        {{ scanning ? 'Scanning…' : `Load more (SCAN cursor ${cursor})` }}
      </button>
      <p v-else-if="scanning" class="message">Scanning…</p>
    </div>
  </div>
</template>

<style scoped>
.key-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.head,
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
}
.head {
  flex: none;
  height: 28px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
}
.head .type {
  width: 40px;
}
.items {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}
.item {
  width: 100%;
  height: 24px;
  border: 0;
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: var(--vscode-list-hoverBackground);
}
.item[aria-selected='true'] {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name.binary {
  font-style: italic;
}
.ttl {
  flex: none;
  min-width: 28px;
  text-align: right;
  color: var(--vscode-editorWarning-foreground);
}
.ttl.none {
  color: var(--vscode-descriptionForeground);
}
.head .ttl {
  color: inherit;
}
.message {
  margin: 8px 10px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.message.error {
  color: var(--vscode-errorForeground);
}
.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  cursor: pointer;
}
.link:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}
.more {
  box-sizing: border-box;
  width: calc(100% - 16px);
  margin: 8px 8px 0;
  justify-content: center;
}
</style>
