<script setup lang="ts">
import type { KafkaConfigEntry, KafkaConfigSource } from '@datakit/core';
import { computed, ref, type Directive } from 'vue';
import IconButton from '../components/IconButton.vue';

/**
 * Config entries of a topic or broker, overrides first. Clicking a value edits it: Enter or leaving the cell saves a
 * changed value, Escape cancels. An override can be reset, so the default applies again.
 */
const props = defineProps<{
  entries: KafkaConfigEntry[];
  /** The source of overrides set on this resource. */
  overrideSource: KafkaConfigSource;
  nameLabel: string;
  editable: boolean;
  /** The entry being saved. */
  saving: string | null;
}>();
const emit = defineEmits<{ set: [name: string, value: string | null] }>();

const filter = ref('');
const editing = ref<{ name: string; draft: string } | null>(null);
const vFocus: Directive<HTMLInputElement> = { mounted: (el) => (el.focus(), el.select()) };

const rows = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return props.entries
    .filter((e) => !needle || e.name.toLowerCase().includes(needle) || (e.value ?? '').toLowerCase().includes(needle))
    .sort((a, b) => Number(b.source === props.overrideSource) - Number(a.source === props.overrideSource) || a.name.localeCompare(b.name));
});
const overrides = computed(() => props.entries.filter((e) => e.source === props.overrideSource).length);

const canEdit = (entry: KafkaConfigEntry) => props.editable && !entry.readOnly && props.saving === null;

function start(entry: KafkaConfigEntry): void {
  if (!canEdit(entry)) return;
  editing.value = { name: entry.name, draft: entry.sensitive ? '' : (entry.value ?? '') };
}

function onKey(event: KeyboardEvent, entry: KafkaConfigEntry): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    editing.value = null;
  } else if (event.key === 'Enter') {
    const draft = editing.value?.draft ?? '';
    editing.value = null;
    if (draft !== (entry.value ?? '') || entry.sensitive) emit('set', entry.name, draft);
  }
}

/** Leaving the cell keeps what was typed; a hidden value left empty stays as it is. */
function onBlur(entry: KafkaConfigEntry): void {
  if (editing.value?.name !== entry.name) return;
  const draft = editing.value.draft;
  editing.value = null;
  if (entry.sensitive ? draft !== '' : draft !== (entry.value ?? '')) emit('set', entry.name, draft);
}

function sourceChip(source: KafkaConfigSource): { label: string; title: string; tone: string } | null {
  if (source === props.overrideSource) return { label: 'override', title: `Set on this ${source}`, tone: 'tone-info' };
  if (source === 'cluster') return { label: 'cluster', title: 'Cluster-wide dynamic default', tone: 'tone-muted' };
  return null;
}
</script>

<template>
  <div class="config-table">
    <div class="tools">
      <input v-model="filter" class="fld filter" aria-label="Filter settings" placeholder="Filter settings" spellcheck="false" />
      <span class="note">{{ entries.length }} settings · {{ overrides }} {{ overrides === 1 ? 'override' : 'overrides' }}</span>
    </div>
    <div class="table-box">
      <table class="grid">
        <colgroup>
          <col class="name-col" />
          <col class="value-col" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{{ nameLabel }}</th>
            <th scope="col">VALUE</th>
            <th scope="col">DESCRIPTION</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in rows" :key="e.name" :class="{ saving: saving === e.name }">
            <td class="name" :title="e.name">
              <span class="c-name">{{ e.name }}</span>
              <span v-if="sourceChip(e.source)" class="chip" :class="sourceChip(e.source)!.tone" :title="sourceChip(e.source)!.title">{{ sourceChip(e.source)!.label }}</span>
            </td>
            <td class="pad0 value">
              <input
                v-if="editing?.name === e.name"
                v-model="editing.draft"
                v-focus
                class="cell-input"
                :type="e.sensitive ? 'password' : 'text'"
                :aria-label="`Value of ${e.name}`"
                spellcheck="false"
                @keydown="onKey($event, e)"
                @blur="onBlur(e)"
              />
              <div v-else class="value-row">
                <button
                  v-if="canEdit(e)"
                  type="button"
                  class="cell"
                  :class="{ muted: e.sensitive || e.value === null }"
                  :aria-label="`${e.name} = ${e.sensitive ? 'hidden' : (e.value ?? 'not set')}. Click to edit`"
                  :title="e.sensitive ? 'Hidden' : (e.value ?? '')"
                  @click="start(e)"
                >
                  {{ e.sensitive ? 'hidden' : (e.value ?? '—') }}
                </button>
                <span v-else class="cell" :class="{ muted: e.sensitive || e.value === null, ro: e.readOnly }" :title="e.readOnly ? 'Read-only: changes need a broker restart' : (e.value ?? '')">
                  {{ e.sensitive ? 'hidden' : (e.value ?? '—') }}
                </span>
                <IconButton v-if="editable && e.source === overrideSource && !e.readOnly" icon="revert" label="Remove the override" class="reset" :disabled="saving !== null" @click="emit('set', e.name, null)" />
              </div>
            </td>
            <td class="wrap doc">{{ e.documentation ?? '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="empty-state">{{ entries.length ? 'No setting matches the filter.' : 'No settings.' }}</p>
    </div>
  </div>
</template>

<style scoped>
.config-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter {
  flex: 0 1 260px;
  height: 26px;
  font-size: 12px;
}
.grid {
  table-layout: fixed;
  min-width: 560px;
}
.name-col {
  width: 34%;
}
.value-col {
  width: 24%;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.name .chip {
  margin-left: 6px;
}
.value-row {
  display: flex;
  align-items: center;
}
.cell {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--vscode-debugTokenExpression-string);
  font: inherit;
  line-height: 28px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}
button.cell {
  cursor: text;
}
button.cell:hover {
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
button.cell:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.cell.ro {
  color: var(--vscode-foreground);
}
.cell.muted {
  font-style: italic;
  color: var(--k-muted);
}
.reset {
  flex: none;
  width: 24px;
  height: 24px;
  margin-right: 4px;
}
.cell-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border: 0;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
.doc {
  padding-top: 5px;
  padding-bottom: 5px;
  font-family: var(--vscode-font-family);
  color: var(--k-muted);
  line-height: 1.4;
}
tr.saving {
  opacity: 0.5;
}
</style>
