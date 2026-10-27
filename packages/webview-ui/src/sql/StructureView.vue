<script setup lang="ts">
import {
  buildAlterTable,
  countDraftChanges,
  draftOf,
  indexKinds,
  mapColumnList,
  referentialActions,
  validateDraft,
  type ColumnDraft,
  type ForeignKeyDraft,
  type IndexDraft,
  type StructureDraft,
  type TableStructure,
} from '@datakit/core';
import { computed, nextTick, ref, watch } from 'vue';
import Icon from '../components/Icon.vue';
import IconButton from '../components/IconButton.vue';
import RevertDot from '../components/RevertDot.vue';

/**
 * Columns, indexes and foreign keys of the table. When it can be changed, the rows are editable;
 * edits collect in a draft whose ALTER TABLE statements are shown and applied together.
 */
const props = defineProps<{
  structure: TableStructure;
  /** Why the table cannot be changed; null when it can. */
  readOnlyReason: string | null;
  tables: string[];
  applying: boolean;
  error: string | null;
  /** The uncommitted writes of the view's open transaction; null when none is open. Apply waits until it ends. */
  openTransaction: number | null;
  /** Why the open transaction cannot be ended from here now; null when it can. */
  endBlocked: string | null;
  /** The draft to start with instead of the table as it is, e.g. the one kept over a reload; it must fit `structure`. */
  initialDraft?: StructureDraft | null;
}>();
/** `draft`: the unapplied edits whenever they change, null when there are none. */
const emit = defineEmits<{
  apply: [statements: string[]];
  viewDdl: [];
  copy: [sql: string];
  endTransaction: [type: 'commit' | 'rollback'];
  draft: [draft: StructureDraft | null];
}>();

const MYSQL_COLUMN_TYPES = [
  'int',
  'bigint',
  'tinyint',
  'smallint',
  'decimal(10,2)',
  'float',
  'double',
  'varchar(255)',
  'char(36)',
  'text',
  'mediumtext',
  'longtext',
  'json',
  'date',
  'datetime',
  'timestamp',
  'time',
  'year',
  'boolean',
  'blob',
  "enum('a','b')",
];
const POSTGRES_COLUMN_TYPES = [
  'integer',
  'bigint',
  'smallint',
  'numeric(10,2)',
  'real',
  'double precision',
  'text',
  'varchar(255)',
  'char(3)',
  'boolean',
  'uuid',
  'jsonb',
  'json',
  'date',
  'timestamptz',
  'timestamp',
  'time',
  'interval',
  'bytea',
  'inet',
  'text[]',
  'integer[]',
];

/** PostgreSQL cannot move columns, calls its auto-numbering an identity, and names its primary keys. */
const postgres = computed(() => props.structure.dialect === 'postgres');
const columnTypes = computed(() => (postgres.value ? POSTGRES_COLUMN_TYPES : MYSQL_COLUMN_TYPES));
const kinds = computed(() => indexKinds(props.structure.dialect));
const actions = computed(() => referentialActions(props.structure.dialect));

const draft = ref<StructureDraft>(props.initialDraft ? (JSON.parse(JSON.stringify(props.initialDraft)) as StructureDraft) : draftOf(props.structure));
const original = computed(() => draftOf(props.structure));
const root = ref<HTMLElement>();
/** Numbers the names of added rows; a restored draft's new rows are counted, so names do not repeat. */
let added = [...draft.value.columns, ...draft.value.indexes, ...draft.value.foreignKeys].filter((r) => r.original === null).length;

// A new structure (after Apply) starts a fresh draft.
watch(
  () => props.structure,
  (structure) => (draft.value = draftOf(structure)),
);

const editable = computed(() => props.readOnlyReason === null);
const errors = computed(() => validateDraft(props.structure, draft.value));
const firstError = computed(() => Object.values(errors.value)[0] ?? null);
const changes = computed(() => countDraftChanges(props.structure, draft.value));
watch(
  draft,
  (value) => emit('draft', changes.value ? value : null),
  { deep: true, immediate: true },
);
const statements = computed(() => (firstError.value ? [] : buildAlterTable(props.structure, draft.value)));
/** DDL commits an open transaction on MySQL; on PostgreSQL the change set needs a transaction of its own. */
const transactionNote = computed(() => {
  const n = props.openTransaction;
  if (n === null) return null;
  const why = postgres.value ? 'the changes run in a transaction of their own' : 'ALTER TABLE would commit it';
  return `A transaction with ${n} uncommitted change${n === 1 ? '' : 's'} is open; ${why}. Commit or roll it back to apply.`;
});
const preview = computed(() => statements.value.map((s) => `${s};`).join('\n\n'));
const keptColumns = computed(() => draft.value.columns.filter((c) => !c.dropped).map((c) => c.name));

const info = (column: ColumnDraft) => props.structure.columns.find((c) => c.name === column.original);
const before = <T extends { original: string | null }>(rows: T[], row: T) => (row.original === null ? undefined : rows.find((r) => r.original === row.original));
const changed = <T extends { original: string | null }>(rows: T[], row: T, key: keyof T) => {
  const old = before(rows, row);
  return old !== undefined && String(old[key]).trim() !== String(row[key]).trim();
};
const colChanged = (c: ColumnDraft, key: keyof ColumnDraft) => changed(original.value.columns, c, key);
const indexChanged = (i: IndexDraft, key: keyof IndexDraft) => changed(original.value.indexes, i, key);
const fkChanged = (f: ForeignKeyDraft, key: keyof ForeignKeyDraft) => changed(original.value.foreignKeys, f, key);
const fieldError = (section: string, index: number, key: string) => errors.value[`${section}.${index}.${key}`];

function extraText(column: ColumnDraft): string {
  const c = info(column);
  if (!c) return '';
  const parts = [];
  if (c.generation) parts.push(`${c.generation.stored ? 'STORED' : 'VIRTUAL'} GENERATED`);
  if (c.onUpdate) parts.push(`on update ${c.onUpdate}`);
  if (c.identity === 'always') parts.push('ALWAYS');
  return parts.join(' · ');
}

async function focusLast(selector: string): Promise<void> {
  await nextTick();
  const inputs = root.value?.querySelectorAll<HTMLInputElement>(selector);
  const input = inputs?.[inputs.length - 1];
  input?.focus();
  input?.select();
}

function addColumn(): void {
  draft.value.columns.push({
    original: null,
    name: `column_${++added}`,
    type: 'varchar(255)',
    nullable: true,
    defaultSql: '',
    autoIncrement: false,
    comment: '',
    dropped: false,
  });
  void focusLast('.column-name');
}

function addIndex(): void {
  draft.value.indexes.push({ original: null, kind: 'INDEX', name: `idx_${props.structure.table}_${++added}`, columns: '', dropped: false });
  void focusLast('.index-columns');
}

function addForeignKey(): void {
  draft.value.foreignKeys.push({
    original: null,
    name: `fk_${props.structure.table}_${++added}`,
    columns: '',
    refTable: '',
    refColumns: '',
    // What the server takes when the clause is left out.
    onUpdate: postgres.value ? 'NO ACTION' : 'RESTRICT',
    onDelete: postgres.value ? 'NO ACTION' : 'RESTRICT',
    dropped: false,
  });
  void focusLast('.fk-columns');
}

/** New rows go away; existing ones are marked and can be restored. */
function toggleDrop<T extends { original: string | null; dropped: boolean }>(rows: T[], row: T): void {
  if (row.original === null) rows.splice(rows.indexOf(row), 1);
  else row.dropped = !row.dropped;
}

function move(index: number, by: -1 | 1): void {
  const columns = draft.value.columns;
  const target = index + by;
  if (target < 0 || target >= columns.length) return;
  [columns[index], columns[target]] = [columns[target]!, columns[index]!];
}

/** MySQL's primary key is always named PRIMARY; PostgreSQL names it like `orders_pkey`. */
const primaryName = computed(() => (postgres.value ? `${props.structure.table}_pkey` : 'PRIMARY'));

function setKind(index: IndexDraft, kind: IndexDraft['kind']): void {
  index.kind = kind;
  if (kind === 'PRIMARY') index.name = primaryName.value;
  else if (index.name === primaryName.value) index.name = `idx_${props.structure.table}_${++added}`;
}

/** The last non-empty name of each column, so clearing a name to retype it keeps the references. */
const lastNames = new WeakMap<ColumnDraft, string>();

/** Renaming a column renames it in the index and foreign key column lists too. */
function rename(column: ColumnDraft, value: string): void {
  const previous = lastNames.get(column) ?? column.name.trim();
  column.name = value;
  const next = value.trim();
  if (!next) {
    if (previous) lastNames.set(column, previous);
    return;
  }
  lastNames.set(column, next);
  if (!previous || previous === next) return;
  const swap = (name: string) => (name === previous ? next : name);
  const uses = (text: string) => mapColumnList(text, (n) => n) !== mapColumnList(text, swap);
  for (const index of draft.value.indexes) if (uses(index.columns)) index.columns = mapColumnList(index.columns, swap);
  for (const fk of draft.value.foreignKeys) if (uses(fk.columns)) fk.columns = mapColumnList(fk.columns, swap);
}

/** Puts one field of a row back to the table's value. */
function revertColumn(column: ColumnDraft, key: keyof ColumnDraft): void {
  const old = before(original.value.columns, column);
  if (!old) return;
  if (key === 'name') rename(column, old.name);
  else Object.assign(column, { [key]: old[key] });
}

function revertIndex(index: IndexDraft, key: keyof IndexDraft): void {
  const old = before(original.value.indexes, index);
  if (old) Object.assign(index, { [key]: old[key] });
}

function revertForeignKey(fk: ForeignKeyDraft, key: keyof ForeignKeyDraft): void {
  const old = before(original.value.foreignKeys, fk);
  if (old) Object.assign(fk, { [key]: old[key] });
}

function revert(): void {
  draft.value = draftOf(props.structure);
}
</script>

<template>
  <div ref="root" class="structure">
    <datalist id="column-types">
      <option v-for="type in columnTypes" :key="type" :value="type" />
    </datalist>
    <datalist id="table-names">
      <option v-for="table in tables" :key="table" :value="table" />
    </datalist>
    <datalist id="column-names">
      <option v-for="name in keptColumns" :key="name" :value="name" />
    </datalist>

    <p v-if="readOnlyReason" class="note read-only">{{ readOnlyReason }}</p>

    <section>
      <div class="heading">
        <h2>Columns</h2>
        <div class="buttons">
          <button v-if="editable" type="button" class="btn" @click="addColumn"><Icon name="plus" :size="14" />Add column</button>
          <button type="button" class="btn" @click="emit('viewDdl')">View DDL</button>
        </div>
      </div>
      <table class="grid mono" :class="{ readonly: !editable }">
        <thead>
          <tr>
            <th v-if="editable && !postgres" class="narrow" />
            <th>Name</th>
            <th>Type</th>
            <th>Nullable</th>
            <th>Default</th>
            <th>Key</th>
            <th>Extra</th>
            <th>Comment</th>
            <th v-if="editable" class="narrow" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(column, i) in draft.columns" :key="column.original ?? `new-${i}`" :class="{ added: !column.original, dropped: column.dropped }">
            <td v-if="editable && !postgres" class="narrow order">
              <IconButton icon="up" label="Move up" :disabled="i === 0 || column.dropped" @click="move(i, -1)" />
              <IconButton icon="down" label="Move down" :disabled="i === draft.columns.length - 1 || column.dropped" @click="move(i, 1)" />
            </td>
            <td :class="{ changed: colChanged(column, 'name') }">
              <input
                :value="column.name"
                class="cell-input column-name"
                :class="{ invalid: fieldError('columns', i, 'name') }"
                :title="fieldError('columns', i, 'name')"
                :disabled="!editable || column.dropped"
                aria-label="Column name"
                spellcheck="false"
                @input="rename(column, ($event.target as HTMLInputElement).value)"
              />
              <RevertDot v-if="colChanged(column, 'name')" label="Revert name" title="Revert to the table's value" @click="revertColumn(column, 'name')" />
            </td>
            <td :class="{ changed: colChanged(column, 'type') }">
              <input
                v-model="column.type"
                class="cell-input type"
                :class="{ invalid: fieldError('columns', i, 'type') }"
                :title="fieldError('columns', i, 'type')"
                :disabled="!editable || column.dropped"
                list="column-types"
                aria-label="Column type"
                spellcheck="false"
              />
              <RevertDot v-if="colChanged(column, 'type')" label="Revert type" title="Revert to the table's value" @click="revertColumn(column, 'type')" />
            </td>
            <td class="center" :class="{ changed: colChanged(column, 'nullable') }">
              <input v-model="column.nullable" type="checkbox" :disabled="!editable || column.dropped" aria-label="Nullable" />
              <RevertDot v-if="colChanged(column, 'nullable')" label="Revert nullable" title="Revert to the table's value" @click="revertColumn(column, 'nullable')" />
            </td>
            <td :class="{ changed: colChanged(column, 'defaultSql') }">
              <input
                v-model="column.defaultSql"
                class="cell-input default"
                :disabled="!editable || column.dropped || !!info(column)?.generation"
                :placeholder="info(column)?.generation ? 'generated' : 'none'"
                :title="postgres ? 'SQL: \'text\', 0, now() or another expression' : 'SQL: \'text\', 0, NULL, CURRENT_TIMESTAMP or (expression)'"
                aria-label="Default"
                spellcheck="false"
              />
              <RevertDot v-if="colChanged(column, 'defaultSql')" label="Revert default" title="Revert to the table's value" @click="revertColumn(column, 'defaultSql')" />
            </td>
            <td class="key">{{ info(column)?.key ?? '' }}</td>
            <td class="extra" :class="{ changed: colChanged(column, 'autoIncrement') }">
              <label v-if="!info(column)?.generation" class="inline">
                <input v-model="column.autoIncrement" type="checkbox" :disabled="!editable || column.dropped" />{{ postgres ? 'identity' : 'auto_increment' }}
              </label>
              <span v-if="extraText(column)">{{ extraText(column) }}</span>
              <RevertDot v-if="colChanged(column, 'autoIncrement')" :label="postgres ? 'Revert identity' : 'Revert auto_increment'" title="Revert to the table's value" @click="revertColumn(column, 'autoIncrement')" />
            </td>
            <td :class="{ changed: colChanged(column, 'comment') }">
              <input v-model="column.comment" class="cell-input comment" :disabled="!editable || column.dropped" aria-label="Comment" />
              <RevertDot v-if="colChanged(column, 'comment')" label="Revert comment" title="Revert to the table's value" @click="revertColumn(column, 'comment')" />
            </td>
            <td v-if="editable" class="narrow">
              <IconButton
                :icon="column.dropped ? 'revert' : 'trash'"
                :label="column.dropped ? 'Keep column' : 'Drop column'"
                @click="toggleDrop(draft.columns, column)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section>
      <div class="heading">
        <h2>Indexes</h2>
        <button v-if="editable" type="button" class="btn" @click="addIndex"><Icon name="plus" :size="14" />Add index</button>
      </div>
      <table v-if="draft.indexes.length" class="grid mono" :class="{ readonly: !editable }">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Name</th>
            <th>Columns</th>
            <th v-if="editable" class="narrow" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(index, i) in draft.indexes" :key="index.original ?? `new-${i}`" :class="{ added: !index.original, dropped: index.dropped }">
            <td :class="{ changed: indexChanged(index, 'kind') }">
              <select
                class="cell-input kind"
                :value="index.kind"
                :disabled="!editable || index.dropped"
                aria-label="Index kind"
                @change="setKind(index, ($event.target as HTMLSelectElement).value as IndexDraft['kind'])"
              >
                <option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
              </select>
              <RevertDot v-if="indexChanged(index, 'kind')" label="Revert kind" title="Revert to the table's value" @click="revertIndex(index, 'kind')" />
            </td>
            <td :class="{ changed: indexChanged(index, 'name') }">
              <input
                v-model="index.name"
                class="cell-input"
                :class="{ invalid: fieldError('indexes', i, 'name') }"
                :title="fieldError('indexes', i, 'name')"
                :disabled="!editable || index.dropped || (index.kind === 'PRIMARY' && !postgres)"
                aria-label="Index name"
                spellcheck="false"
              />
              <RevertDot v-if="indexChanged(index, 'name')" label="Revert name" title="Revert to the table's value" @click="revertIndex(index, 'name')" />
            </td>
            <td :class="{ changed: indexChanged(index, 'columns') }">
              <input
                v-model="index.columns"
                class="cell-input wide index-columns"
                :class="{ invalid: fieldError('indexes', i, 'columns') }"
                :title="fieldError('indexes', i, 'columns') ?? (postgres ? 'Comma-separated, e.g. email, name DESC' : 'Comma-separated; add a length for a prefix, e.g. name(10)')"
                :disabled="!editable || index.dropped"
                list="column-names"
                :placeholder="postgres ? 'email, name' : 'email, name(10)'"
                aria-label="Index columns"
                spellcheck="false"
              />
              <RevertDot v-if="indexChanged(index, 'columns')" label="Revert columns" title="Revert to the table's value" @click="revertIndex(index, 'columns')" />
            </td>
            <td v-if="editable" class="narrow">
              <IconButton
                :icon="index.dropped ? 'revert' : 'trash'"
                :label="index.dropped ? 'Keep index' : 'Drop index'"
                @click="toggleDrop(draft.indexes, index)"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">{{ structure.kind === 'view' ? 'Views have no indexes.' : 'No indexes.' }}</p>
    </section>

    <section v-if="structure.kind === 'table'">
      <div class="heading">
        <h2>Foreign keys</h2>
        <button v-if="editable" type="button" class="btn" @click="addForeignKey"><Icon name="plus" :size="14" />Add foreign key</button>
      </div>
      <table v-if="draft.foreignKeys.length" class="grid mono" :class="{ readonly: !editable }">
        <thead>
          <tr>
            <th>Name</th>
            <th>Columns</th>
            <th>References</th>
            <th>Referenced columns</th>
            <th>On update</th>
            <th>On delete</th>
            <th v-if="editable" class="narrow" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(fk, i) in draft.foreignKeys" :key="fk.original ?? `new-${i}`" :class="{ added: !fk.original, dropped: fk.dropped }">
            <td :class="{ changed: fkChanged(fk, 'name') }">
              <input
                v-model="fk.name"
                class="cell-input"
                :class="{ invalid: fieldError('foreignKeys', i, 'name') }"
                :title="fieldError('foreignKeys', i, 'name')"
                :disabled="!editable || fk.dropped"
                aria-label="Foreign key name"
                spellcheck="false"
              />
              <RevertDot v-if="fkChanged(fk, 'name')" label="Revert name" title="Revert to the table's value" @click="revertForeignKey(fk, 'name')" />
            </td>
            <td :class="{ changed: fkChanged(fk, 'columns') }">
              <input
                v-model="fk.columns"
                class="cell-input fk-columns"
                :class="{ invalid: fieldError('foreignKeys', i, 'columns') }"
                :title="fieldError('foreignKeys', i, 'columns')"
                :disabled="!editable || fk.dropped"
                list="column-names"
                placeholder="customer_id"
                aria-label="Foreign key columns"
                spellcheck="false"
              />
              <RevertDot v-if="fkChanged(fk, 'columns')" label="Revert columns" title="Revert to the table's value" @click="revertForeignKey(fk, 'columns')" />
            </td>
            <td :class="{ changed: fkChanged(fk, 'refTable') }">
              <input
                v-model="fk.refTable"
                class="cell-input"
                :class="{ invalid: fieldError('foreignKeys', i, 'refTable') }"
                :title="fieldError('foreignKeys', i, 'refTable')"
                :disabled="!editable || fk.dropped"
                list="table-names"
                placeholder="customers"
                aria-label="Referenced table"
                spellcheck="false"
              />
              <RevertDot v-if="fkChanged(fk, 'refTable')" label="Revert referenced table" title="Revert to the table's value" @click="revertForeignKey(fk, 'refTable')" />
            </td>
            <td :class="{ changed: fkChanged(fk, 'refColumns') }">
              <input
                v-model="fk.refColumns"
                class="cell-input"
                :class="{ invalid: fieldError('foreignKeys', i, 'refColumns') }"
                :title="fieldError('foreignKeys', i, 'refColumns')"
                :disabled="!editable || fk.dropped"
                placeholder="id"
                aria-label="Referenced columns"
                spellcheck="false"
              />
              <RevertDot v-if="fkChanged(fk, 'refColumns')" label="Revert referenced columns" title="Revert to the table's value" @click="revertForeignKey(fk, 'refColumns')" />
            </td>
            <td :class="{ changed: fkChanged(fk, 'onUpdate') }">
              <select v-model="fk.onUpdate" class="cell-input" :disabled="!editable || fk.dropped" aria-label="On update">
                <option v-for="action in actions" :key="action" :value="action">{{ action }}</option>
              </select>
              <RevertDot v-if="fkChanged(fk, 'onUpdate')" label="Revert on update" title="Revert to the table's value" @click="revertForeignKey(fk, 'onUpdate')" />
            </td>
            <td :class="{ changed: fkChanged(fk, 'onDelete') }">
              <select v-model="fk.onDelete" class="cell-input" :disabled="!editable || fk.dropped" aria-label="On delete">
                <option v-for="action in actions" :key="action" :value="action">{{ action }}</option>
              </select>
              <RevertDot v-if="fkChanged(fk, 'onDelete')" label="Revert on delete" title="Revert to the table's value" @click="revertForeignKey(fk, 'onDelete')" />
            </td>
            <td v-if="editable" class="narrow">
              <IconButton
                :icon="fk.dropped ? 'revert' : 'trash'"
                :label="fk.dropped ? 'Keep foreign key' : 'Drop foreign key'"
                @click="toggleDrop(draft.foreignKeys, fk)"
              />
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">No foreign keys.</p>
    </section>

    <section v-if="changes || error" class="pending" aria-label="Pending structure changes">
      <div class="heading">
        <h2>{{ changes }} pending change{{ changes === 1 ? '' : 's' }}</h2>
        <div class="buttons">
          <IconButton v-if="preview" icon="copy" label="Copy SQL" @click="emit('copy', preview)" />
          <button type="button" class="btn" :disabled="applying" @click="revert">Revert</button>
          <button
            type="button"
            class="btn btn-primary"
            :title="transactionNote ?? undefined"
            :disabled="applying || !!firstError || !statements.length || openTransaction !== null"
            @click="emit('apply', statements)"
          >
            {{ applying ? 'Applying…' : 'Apply' }}
          </button>
        </div>
      </div>
      <div v-if="transactionNote && statements.length" class="transaction" role="status">
        <Icon name="info" :size="14" />
        <span>{{ transactionNote }}</span>
        <button type="button" class="btn" :disabled="!!endBlocked" :title="endBlocked ?? undefined" @click="emit('endTransaction', 'commit')">Commit</button>
        <button type="button" class="btn" :disabled="!!endBlocked" :title="endBlocked ?? undefined" @click="emit('endTransaction', 'rollback')">Roll back</button>
      </div>
      <p v-if="firstError" class="problem" role="alert"><Icon name="error" :size="14" />{{ firstError }}</p>
      <p v-else-if="error" class="problem" role="alert"><Icon name="error" :size="14" />{{ error }}</p>
      <pre v-if="preview" class="sql mono">{{ preview }}</pre>
    </section>
  </div>
</template>

<style scoped>
.structure {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.read-only {
  margin: 0;
}
.heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.grid {
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  border-top: 1px solid var(--vscode-panel-border);
  border-left: 1px solid var(--vscode-panel-border);
  font-size: 12px;
}
th,
td {
  height: 28px;
  padding: 0 6px;
  border-right: 1px solid var(--vscode-panel-border);
  border-bottom: 1px solid var(--vscode-panel-border);
  white-space: nowrap;
  text-align: left;
}
th {
  padding: 0 10px;
  background: var(--vscode-editorWidget-background);
  font-weight: 500;
}
.narrow {
  width: 1%;
  padding: 0 2px;
}
.order {
  white-space: nowrap;
}
.center {
  text-align: center;
}
.cell-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 80px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: inherit;
}
.cell-input:hover:not(:disabled) {
  border-color: var(--vscode-input-border, var(--vscode-panel-border));
}
.cell-input:focus {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-input-background);
}
.cell-input.invalid {
  border-color: var(--vscode-inputValidation-errorBorder);
}
.cell-input:disabled {
  opacity: 1;
  color: inherit;
}
select.cell-input:disabled {
  appearance: none;
}
.cell-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
.type {
  min-width: 130px;
  color: var(--vscode-symbolIcon-typeParameterForeground);
}
.default {
  min-width: 110px;
  color: var(--vscode-debugTokenExpression-string);
}
.comment {
  min-width: 140px;
}
.wide {
  min-width: 220px;
}
.kind {
  min-width: 100px;
}
.key {
  padding: 0 10px;
  color: var(--vscode-charts-orange);
}
.extra {
  padding: 0 10px;
  color: var(--vscode-descriptionForeground);
}
.extra .inline {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-right: 8px;
}
tr.added td {
  background: var(--vscode-diffEditor-insertedLineBackground);
}
tr.dropped td {
  background: var(--vscode-diffEditor-removedLineBackground);
  color: var(--vscode-gitDecoration-deletedResourceForeground);
  text-decoration: line-through;
}
td {
  position: relative;
}
td.changed .cell-input {
  padding-right: 24px;
}
td.changed {
  box-shadow: inset 0 0 0 1px var(--vscode-gitDecoration-modifiedResourceForeground);
  background: var(--vscode-inputValidation-warningBackground);
}
.pending {
  position: sticky;
  bottom: -16px;
  margin: 0 -12px -16px;
  padding: 10px 12px 12px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editor-background);
}
.transaction {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--vscode-editorWarning-foreground);
}
.transaction span {
  color: var(--vscode-foreground);
}
.problem {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--vscode-errorForeground);
}
.sql {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background));
  font-size: 12px;
  white-space: pre;
}
</style>
