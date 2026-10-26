<script setup lang="ts">
import type { MongoDocument } from '@datakit/core';
import { computed, ref, watch } from 'vue';
import IconButton from '../components/IconButton.vue';
import { documentKey, firstLines, formatBytes } from './format';
import ShellText from './ShellText.vue';

/**
 * One card per document, its shell text colored like the editor. Long documents are cut to the first lines until
 * “Show all”. A click picks the card (the page opens it in the document pane); the actions show on hover.
 * `actions` turns on Edit, Duplicate and Delete for documents that have an `_id`.
 */
const props = defineProps<{ documents: MongoDocument[]; picked: string | null; actions: boolean; pickable: boolean }>();
const emit = defineEmits<{
  pick: [document: MongoDocument, key: string];
  edit: [document: MongoDocument, key: string];
  copy: [document: MongoDocument];
  duplicate: [document: MongoDocument];
  delete: [document: MongoDocument];
}>();

/** Lines a card shows before “Show all”; fewer than MIN_HIDDEN extra lines are shown anyway. */
const LINES = 14;
const MIN_HIDDEN = 4;
const expanded = ref(new Set<string>());

watch(
  () => props.documents,
  () => (expanded.value = new Set([...expanded.value].filter((k) => props.documents.some((d, i) => documentKey(d, i) === k)))),
);

const cards = computed(() =>
  props.documents.map((d, i) => {
    const key = documentKey(d, i);
    const open = expanded.value.has(key);
    const cut = open ? { text: d.text, hidden: 0 } : firstLines(d.text, LINES);
    const shown = cut.hidden < MIN_HIDDEN ? { text: d.text, hidden: 0 } : cut;
    return { d, key, open, text: shown.text, hidden: shown.hidden };
  }),
);

function toggle(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function pick(d: MongoDocument, key: string): void {
  // Selecting text in a card is not a click on it.
  if (window.getSelection()?.toString()) return;
  if (props.pickable) emit('pick', d, key);
}
</script>

<template>
  <div class="document-list" role="list" aria-label="Documents">
    <article
      v-for="c in cards"
      :key="c.key"
      role="listitem"
      class="card"
      :class="{ picked: picked === c.key, pickable }"
      :tabindex="pickable ? 0 : -1"
      :aria-current="picked === c.key ? 'true' : undefined"
      @click="pick(c.d, c.key)"
      @keydown.enter.self="pick(c.d, c.key)"
    >
      <div class="tools" @click.stop>
        <span class="size">{{ formatBytes(c.d.size) }}</span>
        <IconButton v-if="actions && c.d.id && !c.d.truncated" icon="edit" label="Edit in the document pane" @click="emit('edit', c.d, c.key)" />
        <IconButton icon="copy" label="Copy the document" @click="emit('copy', c.d)" />
        <IconButton v-if="actions && !c.d.truncated" icon="duplicate" label="Duplicate: insert a copy without _id" @click="emit('duplicate', c.d)" />
        <IconButton v-if="actions && c.d.id" icon="trash" label="Delete the document" tone="danger" @click="emit('delete', c.d)" />
      </div>
      <pre class="body"><ShellText :text="c.text" /></pre>
      <div v-if="c.d.truncated || c.hidden || c.open" class="foot" @click.stop>
        <span v-if="c.d.truncated" class="chip tone-warn" title="Documents over 1 MiB show only their start and cannot be edited here">Truncated</span>
        <button v-if="c.hidden" type="button" class="lnk" @click="toggle(c.key)">Show all · {{ c.hidden }} more lines</button>
        <button v-else-if="c.open" type="button" class="lnk" @click="toggle(c.key)">Show less</button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.document-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}
.card {
  position: relative;
  border: 1px solid var(--m-border);
  border-radius: 4px;
  background: var(--vscode-editor-background);
  outline: none;
}
.card.pickable {
  cursor: pointer;
}
.card.pickable:hover {
  border-color: color-mix(in srgb, var(--vscode-focusBorder) 50%, var(--m-border));
}
.card:focus-visible {
  border-color: var(--vscode-focusBorder);
}
.card.picked {
  border-color: var(--vscode-focusBorder);
  box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
}
.body {
  margin: 0;
  padding: 8px 12px 8px 14px;
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  line-height: 18px;
  cursor: inherit;
}
.tools {
  position: absolute;
  top: 4px;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 2px 0 8px;
  border-radius: 4px;
  background: var(--vscode-editor-background);
  opacity: 0;
  cursor: default;
}
.card:hover .tools,
.card:focus-within .tools,
.card.picked .tools {
  opacity: 1;
}
.tools :deep(.toolbar-btn) {
  width: 24px;
  height: 24px;
}
.size {
  padding-right: 6px;
  font-size: 11px;
  color: var(--m-muted);
}
.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px 8px 14px;
  font-size: 12px;
  cursor: default;
}
.foot .lnk {
  font-size: 12px;
}
@media (hover: none) {
  .tools {
    opacity: 1;
  }
}
</style>
