import type { FieldErrors } from '../validation';
import type { IndexKind, ReferentialAction } from './table';

/**
 * The Structure tab's edits as a draft, shared by the dialects; `alterTable.ts` turns it into MySQL and MariaDB DDL,
 * `postgres/alterTable.ts` into PostgreSQL DDL. Rows keep the name they had in the table (`original`), so a change
 * can be told from a drop and an add.
 */

export interface ColumnDraft {
  /** The existing column this row edits; null for a new column. */
  original: string | null;
  name: string;
  /** Full type, e.g. `varchar(255)` or `int unsigned`. */
  type: string;
  nullable: boolean;
  /** Default as SQL (`'x'`, `0`, `NULL`, `CURRENT_TIMESTAMP`); empty for none. */
  defaultSql: string;
  /** The server numbers new rows: AUTO_INCREMENT on MySQL, an identity column on PostgreSQL. */
  autoIncrement: boolean;
  comment: string;
  dropped: boolean;
}

export interface IndexDraft {
  original: string | null;
  kind: IndexKind;
  name: string;
  /** Comma-separated, with optional prefix lengths on MySQL: `code(2), name`. */
  columns: string;
  dropped: boolean;
}

export interface ForeignKeyDraft {
  original: string | null;
  name: string;
  columns: string;
  /** `table`, or with its database (MySQL) or schema (PostgreSQL): `inventory.products`. */
  refTable: string;
  refColumns: string;
  onUpdate: ReferentialAction;
  onDelete: ReferentialAction;
  dropped: boolean;
}

export interface CheckDraft {
  original: string | null;
  name: string;
  /** The condition without the CHECK keyword, e.g. `total >= 0`. */
  clause: string;
  dropped: boolean;
}

/** Name and options of the table itself (MySQL); numbers stay text until validated. */
export interface TableDraft {
  name: string;
  comment: string;
  engine: string;
  charset: string;
  collation: string;
  /** Converts the existing text columns to the character set too, instead of changing only the default. */
  convert: boolean;
  autoIncrement: string;
}

export interface StructureDraft {
  /** Null for views and on PostgreSQL. */
  table: TableDraft | null;
  columns: ColumnDraft[];
  indexes: IndexDraft[];
  foreignKeys: ForeignKeyDraft[];
  checks: CheckDraft[];
}

export interface ColumnRef {
  name: string;
  /** Prefix length, e.g. 10 for `name(10)`. */
  length: number | null;
  /** `ASC`, `DESC` or empty. */
  order: string;
}

/**
 * `a, b(10) DESC` → parts, or null for an entry that is not a column reference. Names may be quoted with backticks
 * or double quotes.
 */
export function parseColumnList(text: string): ColumnRef[] | null {
  const parts = text.split(',').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) return null;
  const result: ColumnRef[] = [];
  for (const part of parts) {
    const match = /^(`(?:[^`]|``)+`|"(?:[^"]|"")+"|[^\s`"()]+)\s*(?:\(\s*(\d+)\s*\))?\s*(ASC|DESC)?$/i.exec(part);
    if (!match) return null;
    const quoted = match[1]!;
    const name = quoted.startsWith('`') ? quoted.slice(1, -1).replace(/``/g, '`') : quoted.startsWith('"') ? quoted.slice(1, -1).replace(/""/g, '"') : quoted;
    result.push({ name, length: match[2] ? Number(match[2]) : null, order: match[3]?.toUpperCase() ?? '' });
  }
  return result;
}

/** Renames columns in a column list (`a, b(10) DESC`), keeping prefix lengths and order; other text is left as it is. */
export function mapColumnList(text: string, rename: (name: string) => string): string {
  const parts = parseColumnList(text);
  if (!parts) return text;
  return parts.map((p) => `${rename(p.name)}${p.length ? `(${p.length})` : ''}${p.order ? ` ${p.order}` : ''}`).join(', ');
}

/** Original name → new name of the columns the draft renames. */
export function renames(draft: StructureDraft): (name: string) => string {
  const map = new Map(draft.columns.filter((c) => c.original !== null && !c.dropped).map((c) => [c.original!, c.name.trim()]));
  return (name) => map.get(name) ?? name;
}

const FOREIGN_KEY_FIELDS = ['name', 'columns', 'refTable', 'refColumns', 'onUpdate', 'onDelete'] as const;

/**
 * Whether a row of the draft differs from the same row of `before` (the table as it is). Column lists are
 * compared after the draft's renames, which the server carries over by itself.
 */
export function indexChanged(before: StructureDraft, d: IndexDraft, rename: (name: string) => string): boolean {
  const old = before.indexes.find((i) => i.original === d.original);
  return !old || old.kind !== d.kind || old.name !== d.name.trim() || mapColumnList(old.columns, rename) !== mapColumnList(d.columns, (n) => n);
}

export function foreignKeyChanged(before: StructureDraft, d: ForeignKeyDraft, rename: (name: string) => string): boolean {
  const old = before.foreignKeys.find((f) => f.original === d.original);
  if (!old) return true;
  const expected = { ...old, columns: mapColumnList(old.columns, rename) };
  return FOREIGN_KEY_FIELDS.some((k) => (k === 'columns' ? expected.columns !== mapColumnList(d.columns, (n) => n) : expected[k] !== d[k].trim()));
}

export function checkChanged(before: StructureDraft, d: CheckDraft): boolean {
  const old = before.checks.find((c) => c.original === d.original);
  return !old || old.name !== d.name.trim() || old.clause !== d.clause.trim();
}

export function columnChanged(before: StructureDraft, d: ColumnDraft): boolean {
  const old = before.columns.find((c) => c.original === d.original);
  return !old || !sameColumn(d, old);
}

function sameColumn(a: ColumnDraft, b: ColumnDraft): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.type.trim() === b.type.trim() &&
    a.nullable === b.nullable &&
    a.defaultSql.trim() === b.defaultSql.trim() &&
    a.autoIncrement === b.autoIncrement &&
    a.comment === b.comment
  );
}

/** How many rows are new, dropped or changed; a new row that is dropped again does not count. */
export function changedRows<T extends { original: string | null; dropped: boolean }>(rows: T[], differs: (row: T) => boolean): number {
  return rows.filter((r) => (r.original === null ? !r.dropped : r.dropped || differs(r))).length;
}

/** Checks the column names and types; returns the names of the kept columns, lower-cased. */
export function validateColumns(draft: StructureDraft, errors: FieldErrors): Set<string> {
  const kept = draft.columns.filter((c) => !c.dropped);
  const names = new Set(kept.map((c) => c.name.trim().toLowerCase()));
  if (!kept.length) errors['columns'] = 'A table needs at least one column.';
  const seen = new Set<string>();
  draft.columns.forEach((c, i) => {
    if (c.dropped) return;
    const name = c.name.trim().toLowerCase();
    if (!name) errors[`columns.${i}.name`] = 'Column name is required.';
    else if (seen.has(name)) errors[`columns.${i}.name`] = `Another column is named “${c.name.trim()}”.`;
    seen.add(name);
    if (!c.type.trim()) errors[`columns.${i}.type`] = 'Column type is required.';
  });
  return names;
}

export function validateChecks(draft: StructureDraft, errors: FieldErrors): void {
  const checkNames = new Set<string>();
  draft.checks.forEach((check, i) => {
    if (check.dropped) return;
    const name = check.name.trim().toLowerCase();
    if (!name) errors[`checks.${i}.name`] = 'Check name is required.';
    else if (checkNames.has(name)) errors[`checks.${i}.name`] = `Another check is named “${check.name.trim()}”.`;
    checkNames.add(name);
    if (!check.clause.trim()) errors[`checks.${i}.clause`] = 'Condition is required.';
  });
}

/** Checks names, column lists and targets of the foreign keys; `names` are the kept columns, lower-cased. */
export function validateForeignKeys(draft: StructureDraft, names: ReadonlySet<string>, errors: FieldErrors): void {
  const fkNames = new Set<string>();
  draft.foreignKeys.forEach((fk, i) => {
    if (fk.dropped) return;
    const name = fk.name.trim().toLowerCase();
    if (!name) errors[`foreignKeys.${i}.name`] = 'Foreign key name is required.';
    else if (fkNames.has(name)) errors[`foreignKeys.${i}.name`] = `Another foreign key is named “${fk.name.trim()}”.`;
    fkNames.add(name);
    const columns = parseColumnList(fk.columns);
    const refColumns = parseColumnList(fk.refColumns);
    const unknown = columns?.find((p) => !names.has(p.name.toLowerCase()));
    if (!columns) errors[`foreignKeys.${i}.columns`] = 'List the columns separated by commas.';
    else if (unknown) errors[`foreignKeys.${i}.columns`] = `There is no column “${unknown.name}”.`;
    if (!fk.refTable.trim()) errors[`foreignKeys.${i}.refTable`] = 'Referenced table is required.';
    if (!refColumns) errors[`foreignKeys.${i}.refColumns`] = 'List the referenced columns separated by commas.';
    else if (columns && columns.length !== refColumns.length) {
      errors[`foreignKeys.${i}.refColumns`] = 'Reference as many columns as the key has.';
    }
  });
}
