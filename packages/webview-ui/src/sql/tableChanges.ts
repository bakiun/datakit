import type { CellValue, LoadedPage, TableChange } from '@datakit/core';
import { computed, ref, type Ref } from 'vue';

/** Rows of the loaded page are `e<index>`; rows added in the grid are `n<number>`. */
export type RowId = string;

export const existingRowId = (index: number): RowId => `e${index}`;
export const pageIndexOf = (id: RowId): number | null => (id.startsWith('e') ? Number(id.slice(1)) : null);

/** A cell of a new row that the user left alone; the server fills in its default. */
export const DEFAULT = Symbol('default');
export type GridValue = CellValue | typeof DEFAULT;

export interface NewRow {
  id: RowId;
  values: Record<string, string | null>;
}

/** Grid edits that are not written yet: changed cells, new rows and rows marked for deletion. Keys are result column names. */
export function useTableChanges(page: Ref<LoadedPage | null>) {
  const updates = ref<Record<number, Record<string, string | null>>>({});
  const deleted = ref(new Set<number>());
  const inserts = ref<NewRow[]>([]);
  let nextId = 1;

  const count = computed(
    () => Object.keys(updates.value).filter((i) => !deleted.value.has(Number(i))).length + inserts.value.length + deleted.value.size,
  );

  function original(index: number, column: string): CellValue | undefined {
    const columnIndex = page.value?.columns.findIndex((c) => c.name === column) ?? -1;
    return columnIndex < 0 ? undefined : page.value?.rows[index]?.[columnIndex];
  }

  /** The value a cell shows, pending edits included. */
  function valueOf(id: RowId, column: string): GridValue {
    const index = pageIndexOf(id);
    if (index === null) {
      const row = inserts.value.find((r) => r.id === id);
      return row && Object.hasOwn(row.values, column) ? row.values[column]! : DEFAULT;
    }
    const update = updates.value[index];
    if (update && Object.hasOwn(update, column)) return update[column]!;
    return original(index, column) ?? null;
  }

  function isChanged(id: RowId, column: string): boolean {
    const index = pageIndexOf(id);
    if (index === null) return inserts.value.some((r) => r.id === id && Object.hasOwn(r.values, column));
    return Object.hasOwn(updates.value[index] ?? {}, column);
  }

  /** Sets a cell; `DEFAULT` clears a new row's cell. Typing back the loaded value drops the edit. */
  function setCell(id: RowId, column: string, value: string | null | typeof DEFAULT): void {
    const index = pageIndexOf(id);
    if (index === null) {
      const row = inserts.value.find((r) => r.id === id);
      if (!row) return;
      if (value === DEFAULT) delete row.values[column];
      else row.values[column] = value;
      return;
    }
    if (value === DEFAULT) return;
    const before = original(index, column);
    const same = value === null ? before === null : before !== null && typeof before !== 'object' && String(before) === value;
    const update = { ...(updates.value[index] ?? {}) };
    if (same) delete update[column];
    else update[column] = value;
    const next = { ...updates.value };
    if (Object.keys(update).length) next[index] = update;
    else delete next[index];
    updates.value = next;
  }

  /** Takes back the edit of one cell: the loaded value, or the default in a new row. */
  function revertCell(id: RowId, column: string): void {
    const index = pageIndexOf(id);
    if (index === null) {
      const row = inserts.value.find((r) => r.id === id);
      if (row) delete row.values[column];
      return;
    }
    const update = { ...(updates.value[index] ?? {}) };
    delete update[column];
    const next = { ...updates.value };
    if (Object.keys(update).length) next[index] = update;
    else delete next[index];
    updates.value = next;
  }

  function addRow(values: Record<string, string | null> = {}): RowId {
    const id = `n${nextId++}`;
    inserts.value = [{ id, values }, ...inserts.value];
    return id;
  }

  /** A new row with the values of an existing one, except what the server generates or the grid cannot copy. */
  function duplicate(id: RowId): RowId | null {
    const columns = page.value?.columns ?? [];
    const values: Record<string, string | null> = {};
    for (const { name, column } of columns) {
      if (!column || column.autoIncrement || column.generated || column.binary) continue;
      const value = valueOf(id, name);
      if (value === DEFAULT || (typeof value === 'object' && value !== null)) continue;
      values[name] = value === null ? null : String(value);
    }
    return addRow(values);
  }

  /** Marks loaded rows for deletion and drops new ones. */
  function remove(ids: Iterable<RowId>): void {
    const next = new Set(deleted.value);
    const dropped = new Set<RowId>();
    for (const id of ids) {
      const index = pageIndexOf(id);
      if (index === null) dropped.add(id);
      else next.add(index);
    }
    deleted.value = next;
    inserts.value = inserts.value.filter((r) => !dropped.has(r.id));
  }

  /** Takes back the deletion of loaded rows. */
  function restore(ids: Iterable<RowId>): void {
    const next = new Set(deleted.value);
    for (const id of ids) {
      const index = pageIndexOf(id);
      if (index !== null) next.delete(index);
    }
    deleted.value = next;
  }

  function isDeleted(id: RowId): boolean {
    const index = pageIndexOf(id);
    return index !== null && deleted.value.has(index);
  }

  function reset(): void {
    updates.value = {};
    deleted.value = new Set();
    inserts.value = [];
  }

  /** The edits in the order they are written: updates, inserts (oldest first), deletes. */
  function changes(): TableChange[] {
    const result: TableChange[] = [];
    for (const [index, values] of Object.entries(updates.value)) {
      if (!deleted.value.has(Number(index))) result.push({ kind: 'update', row: Number(index), values });
    }
    for (const row of [...inserts.value].reverse()) result.push({ kind: 'insert', values: row.values });
    for (const index of deleted.value) result.push({ kind: 'delete', row: index });
    return result;
  }

  return { inserts, count, valueOf, isChanged, isDeleted, setCell, revertCell, addRow, duplicate, remove, restore, reset, changes };
}

export type TableChanges = ReturnType<typeof useTableChanges>;
