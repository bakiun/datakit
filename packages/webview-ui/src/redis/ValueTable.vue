<script setup lang="ts">
import {
  editProblem,
  REDIS_EXPORT_FORMATS,
  sameRedisText,
  type HashRow,
  type ListRow,
  type RedisEdit,
  type RedisExportFormat,
  type RedisText,
  type SetRow,
  type StreamRow,
  type ZsetRow,
} from '@datakit/core';
import { computed, ref, watch, type Directive } from 'vue';
import IconButton from '../components/IconButton.vue';
import { isBinary, longTtl, parseTtl, textOf } from './format';

export type CollectionType = 'hash' | 'list' | 'set' | 'zset' | 'stream';
export type ValueRow = HashRow | ListRow | SetRow | ZsetRow | StreamRow;

/**
 * The items of a hash, list, set, sorted set or stream. A cell edit is written when Enter is pressed or the cell
 * loses focus; Esc cancels. An edit that is not valid keeps its editor open with the reason. Binary items are shown
 * as `\x..` escapes and cannot be edited here.
 */
const props = defineProps<{
  keyName: RedisText;
  type: CollectionType;
  rows: ValueRow[];
  length: number | null;
  hasMore: boolean;
  fieldTtl: boolean;
  readOnly: boolean;
  busy: boolean;
}>();
/** `dismiss`: an editor was closed with Esc, so a message about its last write is no longer current. */
const emit = defineEmits<{ edit: [edit: RedisEdit]; more: []; reload: []; export: [format: RedisExportFormat]; dismiss: [] }>();
const active = defineModel<number>('active', { required: true });

interface Column {
  id: string;
  label: string;
  hint?: string;
  readOnly?: boolean;
  width?: string;
}

const columns = computed((): Column[] => {
  switch (props.type) {
    case 'hash':
      return [
        { id: 'field', label: 'field', width: '30%' },
        { id: 'value', label: 'value' },
        ...(props.fieldTtl ? [{ id: 'ttl', label: 'TTL', hint: 'per field', width: '150px' }] : []),
      ];
    case 'list':
      return [{ id: 'index', label: 'index', readOnly: true, width: '80px' }, { id: 'value', label: 'element' }];
    case 'set':
      return [{ id: 'member', label: 'member' }];
    case 'zset':
      return [{ id: 'member', label: 'member', width: '50%' }, { id: 'score', label: 'score' }];
    case 'stream':
      return [{ id: 'id', label: 'id', readOnly: true, width: '180px' }, { id: 'fields', label: 'fields', readOnly: true }];
  }
});
const unit = computed(() => ({ hash: 'field', list: 'element', set: 'member', zset: 'member', stream: 'entry' })[props.type]);
const addLabel = computed(() => ({ hash: 'Add field', list: 'Push element', set: 'Add member', zset: 'Add member', stream: 'Add entry' })[props.type]);

function cell(row: ValueRow, column: string): RedisText | number | null {
  const r = row as unknown as Record<string, unknown>;
  if (column === 'fields') return JSON.stringify(Object.fromEntries((row as StreamRow).fields.map(([f, v]) => [textOf(f), textOf(v)])));
  return r[column] as RedisText | number | null;
}

function display(row: ValueRow, column: Column): { text: string; muted: boolean; binary: boolean } {
  const value = cell(row, column.id);
  if (column.id === 'ttl') return { text: value === null ? '—' : longTtl(value as number), muted: value === null, binary: false };
  if (value === null) return { text: '—', muted: true, binary: false };
  if (typeof value === 'number') return { text: String(value), muted: false, binary: false };
  if (isBinary(value)) return { text: textOf(value), muted: true, binary: true };
  return { text: value === '' ? '(empty)' : value, muted: value === '', binary: false };
}

function canEdit(row: ValueRow, column: Column): boolean {
  return !props.readOnly && !column.readOnly && props.type !== 'stream' && !display(row, column).binary;
}

/** The open cell editor; `problem` says why its draft cannot be written, `quiet` keeps it from taking the focus. */
const editing = ref<{ row: number; column: string; draft: string; problem?: string; quiet?: boolean } | null>(null);
const adding = ref<Record<string, string> | null>(null);
const selected = ref(new Set<number>());
const vFocus: Directive<HTMLInputElement | HTMLTextAreaElement, boolean | undefined> = {
  mounted: (el, binding) => binding.value !== true && (el.focus(), el.select()),
};
const vFocusIf: Directive<HTMLInputElement, boolean> = { mounted: (el, binding) => binding.value && el.focus() };

watch(
  () => props.rows,
  () => {
    editing.value = null;
    selected.value = new Set([...selected.value].filter((i) => i < props.rows.length));
  },
);

watch(
  () => editing.value?.draft,
  () => {
    if (editing.value?.problem) editing.value.problem = undefined;
  },
);

function startEdit(index: number, column: Column): void {
  active.value = index;
  const row = props.rows[index]!;
  if (!canEdit(row, column)) return;
  const value = cell(row, column.id);
  editing.value = { row: index, column: column.id, draft: value === null ? '' : typeof value === 'number' ? String(value) : textOf(value) };
}

/** The edit a changed cell makes, or null when nothing changed. */
function editFor(row: ValueRow, column: string, draft: string): RedisEdit | null {
  const key = props.keyName;
  switch (props.type) {
    case 'hash': {
      const r = row as HashRow;
      if (column === 'field') return draft !== textOf(r.field) ? { kind: 'hashRenameField', key, from: r.field, to: draft, value: r.value } : null;
      if (column === 'value') return draft !== textOf(r.value) ? { kind: 'hashSet', key, field: r.field, value: draft } : null;
      const ttl = parseTtl(draft);
      return ttl !== r.ttl ? { kind: 'hashFieldTtl', key, field: r.field, ttl } : null;
    }
    case 'list': {
      const r = row as ListRow;
      return draft !== textOf(r.value) ? { kind: 'listSet', key, index: r.index, value: draft, expected: r.value } : null;
    }
    case 'set': {
      const r = row as SetRow;
      return draft !== textOf(r.member) ? { kind: 'setRename', key, from: r.member, to: draft } : null;
    }
    case 'zset': {
      const r = row as ZsetRow;
      if (column === 'member') return draft !== textOf(r.member) ? { kind: 'zsetRename', key, from: r.member, to: draft, score: r.score } : null;
      return draft.trim() !== r.score ? { kind: 'zsetAdd', key, member: r.member, score: draft.trim() } : null;
    }
    default:
      return null;
  }
}

function commit(): void {
  const current = editing.value;
  const row = current ? props.rows[current.row] : undefined;
  const edit = current && row ? editFor(row, current.column, current.draft) : null;
  const problem = edit && editProblem(edit);
  if (current && problem) {
    // Kept open with the reason, so what was typed can be fixed instead of typed again.
    current.problem = problem;
    return;
  }
  editing.value = null;
  if (edit) emit('edit', edit);
}

function onCellKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    editing.value = null;
    emit('dismiss');
  }
  // In a multi-line value Shift+Enter starts a new line.
  else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    commit();
  }
}

const addFields = computed((): { id: string; label: string }[] => {
  switch (props.type) {
    case 'hash':
      return [{ id: 'field', label: 'field' }, { id: 'value', label: 'value' }];
    case 'list':
      return [{ id: 'value', label: 'element' }];
    case 'set':
      return [{ id: 'member', label: 'member' }];
    case 'zset':
      return [{ id: 'member', label: 'member' }, { id: 'score', label: 'score' }];
    case 'stream':
      return [{ id: 'field', label: 'field' }, { id: 'value', label: 'value' }];
  }
});

function startAdd(): void {
  editing.value = null;
  adding.value = props.type === 'zset' ? { member: '', score: '0' } : {};
}

const addEdit = computed((): RedisEdit | null => {
  const v = adding.value;
  if (!v) return null;
  const key = props.keyName;
  const edits: Record<CollectionType, RedisEdit> = {
    hash: { kind: 'hashSet', key, field: v.field ?? '', value: v.value ?? '' },
    list: { kind: 'listPush', key, value: v.value ?? '' },
    set: { kind: 'setAdd', key, member: v.member ?? '' },
    zset: { kind: 'zsetAdd', key, member: v.member ?? '', score: v.score ?? '0' },
    stream: { kind: 'streamAdd', key, fields: [[v.field ?? '', v.value ?? '']] },
  };
  return edits[props.type];
});
const addProblem = computed(() => (addEdit.value ? editProblem(addEdit.value) : null));

function submitAdd(): void {
  const edit = addEdit.value;
  if (!edit || addProblem.value || props.busy) return;
  adding.value = null;
  emit('edit', edit);
}

function onAddKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    adding.value = null;
    emit('dismiss');
  }
}

function deleteSelected(): void {
  const rows = [...selected.value].sort((a, b) => a - b).map((i) => props.rows[i]!);
  if (!rows.length) return;
  const key = props.keyName;
  const edits: Record<CollectionType, () => RedisEdit> = {
    hash: () => ({ kind: 'hashDelete', key, fields: (rows as HashRow[]).map((r) => r.field) }),
    list: () => ({ kind: 'listDelete', key, items: (rows as ListRow[]).map((r) => ({ index: r.index, expected: r.value })) }),
    set: () => ({ kind: 'setDelete', key, members: (rows as SetRow[]).map((r) => r.member) }),
    zset: () => ({ kind: 'zsetDelete', key, members: (rows as ZsetRow[]).map((r) => r.member) }),
    stream: () => ({ kind: 'streamDelete', key, ids: (rows as StreamRow[]).map((r) => r.id) }),
  };
  emit('edit', edits[props.type]());
  selected.value = new Set();
}

/** The row an edit was made on: the one at `index` when it still matches, else the only row that matches. */
function locate(match: (row: ValueRow) => boolean, index = -1): number {
  const at = props.rows[index];
  if (at && match(at)) return index;
  const found = props.rows.flatMap((row, i) => (match(row) ? [i] : []));
  return found.length === 1 ? found[0]! : -1;
}

/**
 * Brings back an edit that was not written, after a declined confirmation or after the value was read again because
 * it had changed: the cell editor or the add form with what was typed, or the selection of a deletion. Returns false
 * when the item cannot be found any more.
 */
function restore(edit: RedisEdit): boolean {
  const idle = !document.activeElement || document.activeElement === document.body;
  const reopen = (match: (row: ValueRow) => boolean, column: string, draft: string, index = -1): boolean => {
    const row = locate(match, index);
    if (row < 0) return false;
    active.value = row;
    editing.value = { row, column, draft, quiet: !idle };
    return true;
  };
  const readd = (values: Record<string, string>): boolean => {
    editing.value = null;
    adding.value = values;
    return true;
  };
  const reselect = (matches: ((row: ValueRow) => boolean)[], indexes: number[] = []): boolean => {
    const found = matches.map((match, i) => locate(match, indexes[i])).filter((i) => i >= 0);
    selected.value = new Set(found);
    return found.length === matches.length;
  };
  const same = sameRedisText;
  switch (edit.kind) {
    case 'hashSet': {
      const field = (r: ValueRow) => same((r as HashRow).field, edit.field);
      return locate(field) >= 0 ? reopen(field, 'value', edit.value) : readd({ field: textOf(edit.field), value: edit.value });
    }
    case 'hashRenameField':
      return reopen((r) => same((r as HashRow).field, edit.from), 'field', edit.to);
    case 'hashFieldTtl':
      return reopen((r) => same((r as HashRow).field, edit.field), 'ttl', edit.ttl === null ? '' : String(edit.ttl));
    case 'listSet':
      return reopen((r) => same((r as ListRow).value, edit.expected), 'value', edit.value, edit.index);
    case 'listPush':
      return readd({ value: edit.value });
    case 'setAdd':
      return readd({ member: edit.member });
    case 'setRename':
      return reopen((r) => same((r as SetRow).member, edit.from), 'member', edit.to);
    case 'zsetAdd': {
      const member = (r: ValueRow) => same((r as ZsetRow).member, edit.member);
      return locate(member) >= 0 ? reopen(member, 'score', edit.score) : readd({ member: textOf(edit.member), score: edit.score });
    }
    case 'zsetRename':
      return reopen((r) => same((r as ZsetRow).member, edit.from), 'member', edit.to);
    case 'streamAdd':
      return readd({ field: edit.fields[0]?.[0] ?? '', value: edit.fields[0]?.[1] ?? '' });
    case 'hashDelete':
      return reselect(edit.fields.map((f) => (r) => same((r as HashRow).field, f)));
    case 'listDelete':
      return reselect(
        edit.items.map((item) => (r) => same((r as ListRow).value, item.expected)),
        edit.items.map((item) => item.index),
      );
    case 'setDelete':
    case 'zsetDelete':
      return reselect(edit.members.map((m) => (r) => same((r as SetRow).member, m)));
    case 'streamDelete':
      return reselect(edit.ids.map((id) => (r) => (r as StreamRow).id === id));
    default:
      return false;
  }
}
defineExpose({ restore });

function toggle(index: number): void {
  const next = new Set(selected.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  selected.value = next;
  active.value = index;
}

const allSelected = computed(() => props.rows.length > 0 && selected.value.size === props.rows.length);
function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(props.rows.map((_, i) => i));
}

const exportFormat = ref<RedisExportFormat>('json');
const READ_ONLY = 'The data source is read-only';
const deleteLabel = computed(() => (props.readOnly ? READ_ONLY : selected.value.size ? 'Delete the selected items' : 'Select items with their checkboxes to delete them'));
const hint = computed(() => {
  if (editing.value?.problem) return editing.value.problem;
  if (props.readOnly) return 'Read-only';
  if (props.type === 'stream') return 'Stream entries cannot be changed, only added and deleted';
  return 'Click a cell to edit · Enter writes to Redis · Esc cancels';
});
const count = computed(() => {
  const total = props.length ?? props.rows.length;
  return `${total.toLocaleString('en-US')} ${unit.value}${total === 1 ? '' : props.type === 'stream' ? 'ies' : 's'}`.replace('entryies', 'entries');
});
</script>

<template>
  <div role="toolbar" aria-label="Value actions" class="toolbar">
    <span class="count">{{ count }}</span>
    <IconButton icon="reload" label="Reload the value" :disabled="busy" @click="emit('reload')" />
    <span class="sep" />
    <IconButton icon="plus" :label="readOnly ? READ_ONLY : addLabel" :disabled="readOnly || busy || adding !== null" @click="startAdd" />
    <IconButton icon="minus" :label="deleteLabel" :disabled="readOnly || busy || !selected.size" @click="deleteSelected" />
    <span class="sep" />
    <label class="field">
      Export
      <select v-model="exportFormat" class="sel" aria-label="Export format">
        <option v-for="f in REDIS_EXPORT_FORMATS" :key="f.value" :value="f.value">{{ f.label }}</option>
      </select>
    </label>
    <IconButton icon="download" label="Export every item of the key" @click="emit('export', exportFormat)" />
    <span class="hint" :class="{ problem: editing?.problem }" :role="editing?.problem ? 'alert' : undefined">{{ hint }}</span>
  </div>

  <form v-if="adding" class="add-row" :aria-label="addLabel" @submit.prevent="submitAdd">
    <input
      v-for="(f, i) in addFields"
      :key="f.id"
      v-focus-if="i === 0"
      v-model="adding[f.id]"
      class="fld mono"
      :placeholder="f.label"
      :aria-label="`New ${f.label}`"
      @keydown="onAddKey"
    />
    <button type="submit" class="btn small primary" :disabled="!!addProblem || busy" :title="addProblem ?? ''">{{ type === 'list' ? 'Push' : 'Add' }}</button>
    <button type="button" class="btn small" @click="adding = null">Cancel</button>
  </form>

  <div class="table-area" :class="{ dim: busy }">
    <table class="grid mono">
      <colgroup>
        <col class="check-col" />
        <col v-for="c in columns" :key="c.id" :style="{ width: c.width }" />
      </colgroup>
      <thead>
        <tr>
          <th class="check"><input type="checkbox" aria-label="Select all items" :checked="allSelected" :disabled="!rows.length" @change="toggleAll" /></th>
          <th v-for="c in columns" :key="c.id" scope="col">
            <span class="head">{{ c.label }}<span v-if="c.hint" class="hint-col">{{ c.hint }}</span></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i" :class="{ active: i === active, selected: selected.has(i) }">
          <td class="check"><input type="checkbox" :aria-label="`Select item ${i + 1}`" :checked="selected.has(i)" @change="toggle(i)" /></td>
          <td v-for="c in columns" :key="c.id" :class="`col-${c.id}`">
            <template v-if="editing?.row === i && editing.column === c.id">
              <textarea
                v-if="editing.draft.includes('\n')"
                v-model="editing.draft"
                v-focus="editing.quiet"
                class="editor"
                :class="{ invalid: editing.problem }"
                rows="3"
                :aria-label="`Edit ${c.label}`"
                :aria-invalid="!!editing.problem"
                :title="editing.problem"
                @keydown="onCellKey"
                @blur="commit"
              />
              <input
                v-else
                v-model="editing.draft"
                v-focus="editing.quiet"
                class="editor"
                :class="{ invalid: editing.problem }"
                :aria-label="`Edit ${c.label}`"
                :aria-invalid="!!editing.problem"
                :title="editing.problem"
                :placeholder="c.id === 'ttl' ? 'e.g. 90, 30m, 2h; empty = no expiry' : undefined"
                @keydown="onCellKey"
                @blur="commit"
              />
            </template>
            <button
              v-else-if="canEdit(row, c)"
              type="button"
              class="cell"
              :class="{ muted: display(row, c).muted }"
              :title="display(row, c).text"
              @click="startEdit(i, c)"
            >
              {{ display(row, c).text }}
            </button>
            <span v-else class="cell" :class="{ muted: display(row, c).muted }" :title="display(row, c).text" @click="active = i">{{ display(row, c).text }}</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length && !adding" class="empty">The key has no items.</p>
    <button v-if="hasMore" type="button" class="btn more" :disabled="busy" @click="emit('more')">Load more</button>
  </div>
</template>

<style scoped>
.toolbar {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: 0 12px;
  padding: 3px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-bottom: 0;
  border-radius: 4px 4px 0 0;
  background: var(--vscode-editorWidget-background);
  font-size: 12px;
}
.count {
  padding: 0 6px;
}
.field {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
}
.sel {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
  border-radius: 4px;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  font: inherit;
}
.sep {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 6px;
  background: var(--vscode-panel-border);
}
.hint {
  margin-left: auto;
  padding: 0 4px;
  color: var(--vscode-descriptionForeground);
}
.hint.problem {
  color: var(--vscode-errorForeground);
}
.table-area {
  flex: 1;
  min-height: 80px;
  overflow: auto;
  margin: 0 12px;
  border: 1px solid var(--vscode-panel-border);
}
.table-area.dim {
  opacity: 0.5;
}
.grid {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}
.check-col {
  width: 36px;
}
th,
td {
  height: 26px;
  padding: 0;
  border-right: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
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
  text-align: center;
}
.head {
  display: flex;
  gap: 6px;
  padding: 0 10px;
}
.hint-col {
  font-weight: 400;
  color: var(--vscode-descriptionForeground);
}
tr.active {
  background: var(--vscode-list-inactiveSelectionBackground);
}
tr.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.cell {
  box-sizing: border-box;
  display: block;
  width: 100%;
  height: 26px;
  padding: 0 10px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 26px;
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
.col-field .cell,
.col-member .cell {
  color: var(--vscode-symbolIcon-variableForeground);
}
.col-value .cell {
  color: var(--vscode-debugTokenExpression-string);
}
.col-score .cell,
.col-ttl .cell {
  color: var(--vscode-debugTokenExpression-number);
}
tr.selected .cell {
  color: inherit;
}
.cell.muted {
  font-style: italic;
  color: var(--vscode-descriptionForeground);
}
.editor {
  box-sizing: border-box;
  width: 100%;
  min-height: 26px;
  padding: 3px 9px;
  border: 1px solid var(--vscode-focusBorder);
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  resize: vertical;
}
.editor.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
.add-row {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 12px;
  padding: 6px 8px;
  border: 1px solid var(--vscode-panel-border);
  border-bottom: 0;
  background: var(--vscode-editorWidget-background);
}
.add-row .fld {
  flex: 1 1 160px;
  height: 26px;
}
.btn.small {
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
}
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.empty {
  margin: 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}
.more {
  margin: 8px;
}
</style>
