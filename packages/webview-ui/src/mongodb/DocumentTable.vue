<script setup lang="ts">
import type { MongoBsonType, MongoDocument, MongoFieldPreview } from '@datakit/core';
import { computed, onBeforeUnmount, ref, watch, type Directive } from 'vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import IconButton from '../components/IconButton.vue';
import { useCollection } from './collection';
import { columnType, documentKey, isScalar, typeTextColor } from './format';

/**
 * The page as a table: `_id`, then every top-level field of the page's documents. A click picks the row (the page
 * opens it in the document pane); a double-click on a whole scalar value edits it in place, Enter writes it with
 * `$set` and Escape cancels. Objects, arrays and cut values open the document pane instead.
 */
const props = defineProps<{ documents: MongoDocument[]; picked: string | null; canWrite: boolean }>();
const emit = defineEmits<{ pick: [document: MongoDocument, key: string]; open: [document: MongoDocument, key: string] }>();
const col = useCollection();

const vFocus: Directive<HTMLInputElement> = { mounted: (el) => (el.focus(), el.select()) };

interface Row {
  d: MongoDocument;
  key: string;
  byName: Map<string, MongoFieldPreview>;
}

const rows = computed((): Row[] => props.documents.map((d, i) => ({ d, key: documentKey(d, i), byName: new Map(d.fields.map((f) => [f.name, f])) })));

/** Field names in the order they first appear, `_id` first. */
const columns = computed(() => {
  const types = new Map<string, MongoBsonType[]>();
  for (const r of rows.value) {
    for (const f of r.d.fields) {
      if (f.name === '_id') continue;
      const list = types.get(f.name) ?? [];
      list.push(f.type);
      types.set(f.name, list);
    }
  }
  return [...types].map(([name, list]) => ({ name, type: columnType(list) }));
});

const editing = ref<{ key: string; field: string; draft: string; original: string } | null>(null);
/** Values written and not read back yet, by row and field; they show until the page is read again. */
const pending = ref(new Map<string, string>());
const unsetting = ref<{ d: MongoDocument; field: string } | null>(null);
const cellId = (key: string, field: string) => `${key}\u0000${field}`;

/** A click picks the row a moment later, so a double-click edits without the pane opening and moving the cells. */
let pickTimer: ReturnType<typeof setTimeout> | undefined;
function onRowClick(r: Row): void {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => emit('pick', r.d, r.key), 220);
}
onBeforeUnmount(() => clearTimeout(pickTimer));

watch(
  () => props.documents,
  () => {
    pending.value = new Map();
    editing.value = null;
  },
);

function editable(r: Row, field: string): boolean {
  if (!props.canWrite || !r.d.id || r.d.truncated || field === '_id') return false;
  const f = r.byName.get(field);
  return !f || (f.complete && isScalar(f.type));
}

function startEdit(r: Row, field: string): void {
  clearTimeout(pickTimer);
  if (!editable(r, field)) {
    emit('open', r.d, r.key);
    return;
  }
  const original = r.byName.get(field)?.preview ?? '';
  editing.value = { key: r.key, field, draft: pending.value.get(cellId(r.key, field)) ?? original, original };
}

function commit(r: Row): void {
  const e = editing.value;
  editing.value = null;
  if (!e || !r.d.id) return;
  const value = e.draft.trim();
  if (!value || value === e.original) return;
  const id = cellId(r.key, e.field);
  pending.value = new Map(pending.value).set(id, value);
  void col.write({ kind: 'setField', id: r.d.id, path: e.field, value }).then((result) => {
    if (result.ok) return;
    const next = new Map(pending.value);
    next.delete(id);
    pending.value = next;
  });
}

function onKey(event: KeyboardEvent, r: Row): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit(r);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    editing.value = null;
  }
}

function onCellKey(event: KeyboardEvent, r: Row, field: string): void {
  if (event.key === 'Enter' || event.key === 'F2') {
    event.preventDefault();
    startEdit(r, field);
  }
}

function unsetAction() {
  const u = unsetting.value!;
  return col.write({ kind: 'unsetField', id: u.d.id!, path: u.field }, { quiet: true });
}

function cellTitle(f: MongoFieldPreview | undefined, r: Row, field: string): string {
  if (!f) return editable(r, field) ? 'No such field · double-click to add it' : 'No such field';
  const parts: string[] = [f.type];
  if (!f.complete) parts.push('cut short · open the document to see all');
  else if (editable(r, field)) parts.push('double-click to edit');
  return parts.join(' · ');
}
</script>

<template>
  <div class="document-table">
    <table class="grid">
      <thead>
        <tr>
          <th scope="col" class="id-col">_id</th>
          <th v-for="c in columns" :key="c.name" scope="col" :title="c.type ? `${c.name}: ${c.type}` : c.name">
            <span class="name">{{ c.name }}</span> <span class="type">{{ c.type }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" :class="{ picked: picked === r.key }" @click="onRowClick(r)">
          <td class="id-col">
            <button type="button" class="cell id" :title="r.d.idText ?? 'No _id'" :aria-label="`Open document ${r.d.idText ?? ''}`">{{ r.d.idText ?? '—' }}</button>
          </td>
          <td v-for="c in columns" :key="c.name" :class="{ pending: pending.has(cellId(r.key, c.name)), editing: editing?.key === r.key && editing.field === c.name }">
            <input
              v-if="editing?.key === r.key && editing.field === c.name"
              v-model="editing.draft"
              v-focus
              class="editor"
              :aria-label="`Edit ${c.name} in shell syntax`"
              spellcheck="false"
              @click.stop
              @keydown="onKey($event, r)"
              @blur="editing = null"
            />
            <template v-else>
              <button
                type="button"
                class="cell"
                :class="{ missing: !r.byName.get(c.name) }"
                :style="pending.has(cellId(r.key, c.name)) ? undefined : { color: r.byName.get(c.name) ? typeTextColor(r.byName.get(c.name)!.type) : undefined }"
                :title="cellTitle(r.byName.get(c.name), r, c.name)"
                @dblclick.stop="startEdit(r, c.name)"
                @keydown="onCellKey($event, r, c.name)"
              >
                {{ pending.get(cellId(r.key, c.name)) ?? r.byName.get(c.name)?.preview ?? '—' }}
              </button>
              <IconButton
                v-if="canWrite && r.d.id && !r.d.truncated && r.byName.get(c.name) && !pending.has(cellId(r.key, c.name))"
                icon="close"
                class="unset"
                :label="`Remove the field ${c.name} from this document`"
                @click.stop="unsetting = { d: r.d, field: c.name }"
              />
            </template>
          </td>
        </tr>
      </tbody>
    </table>

    <ConfirmDialog
      v-if="unsetting"
      title="Remove field"
      :text="`Remove ${unsetting.field} from the document ${unsetting.d.idText ?? ''}? This runs $unset on the server.`"
      primary="Remove field"
      :action="unsetAction"
      @close="unsetting = null"
    />
  </div>
</template>

<style scoped>
.document-table {
  min-width: 0;
}
.grid {
  width: auto;
  min-width: 100%;
}
.grid th,
.grid td {
  position: relative;
  padding: 0;
  border-right: 1px solid var(--m-border);
}
.grid th {
  height: 30px;
  padding: 0 10px;
}
.name {
  color: var(--vscode-foreground);
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
  letter-spacing: 0;
}
.type {
  font-weight: 400;
  letter-spacing: 0;
}
tbody tr {
  cursor: pointer;
}
tbody tr.picked {
  background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
  box-shadow: inset 3px 0 0 var(--vscode-focusBorder);
}
.cell {
  box-sizing: border-box;
  display: block;
  width: 100%;
  max-width: 320px;
  height: 28px;
  padding: 0 10px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: inherit;
}
.cell:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.cell.id {
  color: var(--vscode-symbolIcon-typeParameterForeground);
}
.cell.missing {
  color: var(--m-muted);
  opacity: 0.6;
}
.unset {
  position: absolute;
  top: 3px;
  right: 2px;
  width: 22px;
  height: 22px;
  display: none;
  background: var(--vscode-editor-background);
}
td:hover .unset,
.unset:focus-visible {
  display: inline-flex;
}
td.pending {
  background: var(--vscode-inputValidation-warningBackground);
  box-shadow: inset 0 0 0 1px var(--vscode-gitDecoration-modifiedResourceForeground);
}
td.pending .cell {
  font-style: italic;
}
.editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 160px;
  height: 28px;
  padding: 0 9px;
  border: 0;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
}
</style>
