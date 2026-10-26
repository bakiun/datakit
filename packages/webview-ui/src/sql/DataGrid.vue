<script setup lang="ts">
import { isEditableColumn, type ResultColumn, type SortKey } from '@datakit/core';
import { computed, ref, type Directive } from 'vue';
import RevertDot from '../components/RevertDot.vue';
import { DEFAULT, pageIndexOf, type RowId, type TableChanges } from './tableChanges';

/**
 * The rows of one page plus the rows added in the grid. Click a header to sort (Shift adds a column),
 * click a cell to edit: Enter saves, Esc cancels, Tab moves on. `rowKey` names table columns.
 */
const props = defineProps<{
  columns: ResultColumn[];
  rowIds: RowId[];
  rowKey: string[];
  sort: SortKey[];
  changes: TableChanges;
  editable: boolean;
  sortable: boolean;
}>();
const selected = defineModel<Set<RowId>>('selected', { required: true });
const emit = defineEmits<{ sort: [column: string, additive: boolean] }>();

const vFocus: Directive<HTMLInputElement | HTMLSelectElement> = {
  mounted(el) {
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  },
};

const editing = ref<{ id: RowId; column: string; draft: string } | null>(null);
const allSelected = computed(() => props.rowIds.length > 0 && props.rowIds.every((id) => selected.value.has(id)));

const isNew = (id: RowId) => pageIndexOf(id) === null;

function toggle(id: RowId): void {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(props.rowIds);
}

function sortIndex(column: ResultColumn): number {
  return props.sort.findIndex((k) => k.column === column.name);
}

function ariaSort(column: ResultColumn): 'ascending' | 'descending' | 'none' {
  const key = props.sort[sortIndex(column)];
  return key ? (key.direction === 'asc' ? 'ascending' : 'descending') : 'none';
}

function badge(column: ResultColumn): string {
  if (column.column?.key === 'PRI') return 'PK';
  return column.column && props.rowKey.includes(column.column.name) ? 'UK' : '';
}

function headTitle(column: ResultColumn): string {
  const info = column.column;
  const details = info ? [info.columnType, info.nullable ? 'nullable' : 'not null'] : [column.type];
  if (info?.defaultValue != null) details.push(`default ${info.defaultValue}`);
  if (info?.extra) details.push(info.extra);
  if (info && info.name !== column.name) details.push(`column ${info.name}`);
  const hint = props.sortable ? 'Click to sort, Shift+click to add' : 'Sorting is off while there are changes or the query cannot be paged';
  return `${details.join(' · ')}\n${hint}`;
}

function canEdit(id: RowId, column: ResultColumn): boolean {
  return props.editable && !!column.column && !props.changes.isDeleted(id) && isEditableColumn(column.column, props.rowKey, !isNew(id));
}

function display(id: RowId, column: ResultColumn): { text: string; muted: boolean; title?: string } {
  const value = props.changes.valueOf(id, column.name);
  if (value === DEFAULT) {
    const info = column.column;
    if (!info) return { text: '', muted: true };
    // NOT NULL without a default: the server rejects the row unless a value is typed in.
    const required = !info.nullable && info.defaultValue === null && !info.autoIncrement && !info.generated;
    const text = info.autoIncrement ? '(auto)' : info.generated ? '(generated)' : required ? '(required)' : '(default)';
    return { text, muted: true, ...(info.defaultValue !== null ? { title: `Default: ${info.defaultValue}` } : {}) };
  }
  if (value === null) return { text: 'NULL', muted: true };
  if (typeof value === 'object') {
    const more = value.hex.length > 32 || value.length * 2 > value.hex.length;
    return { text: `0x${value.hex.slice(0, 32)}${more ? '…' : ''}`, muted: true, title: `${value.length} bytes` };
  }
  const text = String(value);
  return { text, muted: false, ...(text.length > 40 ? { title: text } : {}) };
}

function startEdit(id: RowId, column: ResultColumn): void {
  const value = props.changes.valueOf(id, column.name);
  editing.value = { id, column: column.name, draft: value === DEFAULT ? '' : value === null ? 'NULL' : String(value) };
}

function parse(id: RowId, column: ResultColumn, draft: string): string | null | typeof DEFAULT {
  const word = draft.trim().toUpperCase();
  if (isNew(id) && word === 'DEFAULT') return DEFAULT;
  if (column.column?.nullable && word === 'NULL') return null;
  return draft;
}

function commit(): void {
  const current = editing.value;
  if (!current) return;
  const column = props.columns.find((c) => c.name === current.column);
  editing.value = null;
  if (column) props.changes.setCell(current.id, column.name, parse(current.id, column, current.draft));
}

function onKey(event: KeyboardEvent, id: RowId, column: ResultColumn): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    editing.value = null;
  } else if (event.key === 'Tab') {
    event.preventDefault();
    commit();
    const editable = props.columns.filter((c) => canEdit(id, c));
    const next = editable[(editable.indexOf(column) + (event.shiftKey ? -1 : 1) + editable.length) % editable.length];
    if (next) startEdit(id, next);
  }
}

function pick(event: Event): void {
  if (editing.value) editing.value.draft = (event.target as HTMLSelectElement).value;
  commit();
}

function choices(id: RowId, column: ResultColumn): { value: string; label: string }[] {
  const list = (column.column?.enumValues ?? []).map((v) => ({ value: v, label: v }));
  if (column.column?.nullable) list.unshift({ value: 'NULL', label: 'NULL' });
  if (isNew(id)) list.unshift({ value: 'DEFAULT', label: '(default)' });
  return list;
}
</script>

<template>
  <table class="grid mono">
    <thead>
      <tr>
        <th class="check">
          <input type="checkbox" aria-label="Select all rows on this page" :checked="allSelected" @change="toggleAll" />
        </th>
        <th v-for="column in columns" :key="column.name" :aria-sort="ariaSort(column)">
          <button
            type="button"
            class="head"
            :class="{ numeric: column.numeric }"
            :disabled="!sortable"
            :title="headTitle(column)"
            @click="emit('sort', column.name, $event.shiftKey)"
          >
            <span v-if="badge(column)" class="badge">{{ badge(column) }}</span>
            <span class="name">{{ column.name }}</span>
            <span class="type">{{ column.type }}</span>
            <span v-if="sortIndex(column) >= 0" class="arrow"
              >{{ sort[sortIndex(column)]!.direction === 'asc' ? '↑' : '↓' }}<sup v-if="sort.length > 1">{{ sortIndex(column) + 1 }}</sup></span
            >
          </button>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="(id, i) in rowIds"
        :key="id"
        :class="{ odd: i % 2 === 1, added: isNew(id), deleted: changes.isDeleted(id), selected: selected.has(id) }"
      >
        <td class="check">
          <input type="checkbox" :aria-label="`Select row ${i + 1}`" :checked="selected.has(id)" @change="toggle(id)" />
        </td>
        <td
          v-for="column in columns"
          :key="column.name"
          :class="{
            changed: changes.isChanged(id, column.name) && !isNew(id),
            'has-dot': changes.isChanged(id, column.name),
            editing: editing?.id === id && editing.column === column.name,
          }"
        >
          <template v-if="editing?.id === id && editing.column === column.name">
            <select v-if="column.column?.enumValues" v-focus class="editor" :aria-label="`Edit ${column.name}`" :value="editing.draft" @change="pick" @blur="editing = null" @keydown="onKey($event, id, column)">
              <option v-for="c in choices(id, column)" :key="c.value" :value="c.value">{{ c.label }}</option>
            </select>
            <input
              v-else
              v-model="editing.draft"
              v-focus
              class="editor"
              :class="{ numeric: column.numeric }"
              :aria-label="`Edit ${column.name}`"
              spellcheck="false"
              @keydown="onKey($event, id, column)"
              @blur="commit"
            />
          </template>
          <button
            v-else-if="canEdit(id, column)"
            type="button"
            class="cell"
            :class="{ numeric: column.numeric, muted: display(id, column).muted }"
            :title="display(id, column).title"
            :aria-label="`${column.name}: ${display(id, column).text}. Click to edit`"
            @click="startEdit(id, column)"
          >
            {{ display(id, column).text }}
          </button>
          <span v-else class="cell static" :class="{ numeric: column.numeric, muted: display(id, column).muted }" :title="display(id, column).title">
            {{ display(id, column).text }}
          </span>
          <RevertDot
            v-if="changes.isChanged(id, column.name) && !(editing?.id === id && editing.column === column.name)"
            :tone="isNew(id) ? 'added' : 'changed'"
            :title="isNew(id) ? 'Back to the default' : 'Revert to the loaded value'"
            :label="`Revert ${column.name}`"
            @click="changes.revertCell(id, column.name)"
          />
        </td>
      </tr>
      <tr v-if="!rowIds.length">
        <td class="empty" :colspan="columns.length + 1">No rows</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.grid {
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 12px;
}
th,
td {
  height: 26px;
  padding: 0;
  border-right: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  text-align: left;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-editorWidget-background);
  font-weight: 500;
}
.check {
  width: 36px;
  padding: 0 10px;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.head:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}
.head:disabled {
  cursor: default;
}
.head.numeric {
  justify-content: flex-end;
}
.badge {
  font-size: 10px;
  font-weight: 700;
  color: var(--vscode-charts-orange);
}
.type {
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
}
.arrow {
  font-weight: 600;
  color: var(--vscode-textLink-foreground);
}
tr.odd {
  background: var(--vscode-tree-tableOddRowsBackground, transparent);
}
tr.added {
  background: var(--vscode-diffEditor-insertedLineBackground);
  color: var(--vscode-gitDecoration-addedResourceForeground);
}
tr.deleted {
  background: var(--vscode-diffEditor-removedLineBackground);
  color: var(--vscode-gitDecoration-deletedResourceForeground);
  text-decoration: line-through;
}
tr.selected:not(.deleted) {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
td {
  position: relative;
}
td.has-dot .cell {
  padding-right: 24px;
}
td.changed {
  background: var(--vscode-inputValidation-warningBackground);
  box-shadow: inset 0 0 0 1px var(--vscode-gitDecoration-modifiedResourceForeground);
}
.cell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 360px;
  height: 26px;
  padding: 0 10px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: inherit;
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
.cell.numeric {
  justify-content: flex-end;
}
.cell.muted {
  font-style: italic;
  color: var(--vscode-descriptionForeground);
}
.editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 120px;
  height: 26px;
  padding: 0 9px;
  border: 0;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
.editor.numeric {
  text-align: right;
}
.empty {
  padding: 12px;
  color: var(--vscode-descriptionForeground);
}
</style>
