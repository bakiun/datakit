import {
  changedRows,
  checkChanged,
  columnChanged,
  foreignKeyChanged,
  indexChanged,
  parseColumnList,
  renames,
  validateChecks,
  validateColumns,
  validateForeignKeys,
  type ColumnDraft,
  type IndexDraft,
  type StructureDraft,
} from '../sql/structureDraft';
import { qualifiedTableName, quoteIdentifier, type IndexInfo, type TableStructure } from '../sql/table';
import type { FieldErrors } from '../validation';

/**
 * PostgreSQL DDL for a Structure tab draft. PostgreSQL changes one aspect of a column per clause (type, default,
 * NULL, identity), renames in statements of their own and keeps comments apart, so a change set becomes several
 * statements; they are meant to run in one transaction. Columns cannot be moved, and there are no table options.
 */

const quote = (name: string) => quoteIdentifier(name, 'postgres');

/** A PostgreSQL string literal; with backslashes it is an escape string, which reads the same whatever `standard_conforming_strings` is. */
export function pgQuoteString(value: string): string {
  const quoted = value.replace(/'/g, "''");
  return value.includes('\\') ? `E'${quoted.replace(/\\/g, '\\\\')}'` : `'${quoted}'`;
}

/** Names that PostgreSQL keeps as typed without quotes; others are shown quoted in column lists. */
const PLAIN_NAME = /^[a-z_][a-z0-9_$]*$/;

function columnListText(s: TableStructure, index: IndexInfo): string {
  // An entry that is not a column of the table is the expression of an expression index.
  return index.columns.map((c) => (s.columns.some((col) => col.name === c) && !PLAIN_NAME.test(c) ? quote(c) : c)).join(', ');
}

export function postgresDraftOf(s: TableStructure): StructureDraft {
  return {
    table: null,
    columns: s.columns.map((c) => ({
      original: c.name,
      name: c.name,
      type: c.columnType,
      nullable: c.nullable,
      // An identity column numbers rows itself and has no default of its own.
      defaultSql: c.identity || c.generation ? '' : (c.defaultSql ?? ''),
      autoIncrement: !!c.identity,
      comment: c.comment,
      dropped: false,
    })),
    indexes: s.indexes.map((i) => ({ original: i.name, kind: i.kind, name: i.name, columns: columnListText(s, i), dropped: false })),
    foreignKeys: s.foreignKeys.map((f) => ({
      original: f.name,
      name: f.name,
      columns: f.columns.join(', '),
      refTable: f.refSchema && f.refSchema !== s.schema ? `${f.refSchema}.${f.refTable}` : f.refTable,
      refColumns: f.refColumns.join(', '),
      onUpdate: f.onUpdate,
      onDelete: f.onDelete,
      dropped: false,
    })),
    checks: s.checks.map((c) => ({ original: c.name, name: c.name, clause: c.clause, dropped: false })),
  };
}

/**
 * Whether the tab can rebuild an index from its kind, name and columns: no expressions, condition, sort order,
 * operator class or storage parameters, and no EXCLUDE constraint behind it.
 */
export function isSimpleIndex(s: TableStructure, index: IndexInfo): boolean {
  if (index.constraint && index.kind === 'INDEX') return false;
  if (!index.columns.every((c) => s.columns.some((col) => col.name === c))) return false;
  const list = /USING \w+ \((.*)\)$/.exec(index.definition ?? '')?.[1];
  if (list === undefined) return index.definition === undefined;
  return list.split(', ').every((item) => /^("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)$/.test(item));
}

export function validatePostgresDraft(s: TableStructure, draft: StructureDraft): FieldErrors {
  const errors: FieldErrors = {};
  const names = validateColumns(draft, errors);
  draft.columns.forEach((c, i) => {
    if (c.dropped || !c.autoIncrement) return;
    if (c.nullable) errors[`columns.${i}.nullable`] = `Identity column “${c.name.trim()}” must be NOT NULL.`;
    else if (c.defaultSql.trim()) errors[`columns.${i}.defaultSql`] = `Identity column “${c.name.trim()}” cannot have a default.`;
  });

  const before = postgresDraftOf(s);
  const rename = renames(draft);
  const indexNames = new Set<string>();
  let primaries = 0;
  draft.indexes.forEach((index, i) => {
    if (index.dropped) return;
    if (index.kind === 'PRIMARY') primaries++;
    const name = index.name.trim().toLowerCase();
    if (!name) errors[`indexes.${i}.name`] = 'Index name is required.';
    else if (indexNames.has(name)) errors[`indexes.${i}.name`] = `Another index is named “${index.name.trim()}”.`;
    indexNames.add(name);
    // An index left as it is stays as the server has it, whatever it is built from.
    if (index.original !== null && !indexChanged(before, index, rename)) return;
    const info = s.indexes.find((x) => x.name === index.original);
    const parts = parseColumnList(index.columns);
    if (info && !isSimpleIndex(s, info)) {
      errors[`indexes.${i}.columns`] = 'This index cannot be rebuilt here (expressions, a condition or options); drop it and create the new one in a script.';
    } else if (!parts) errors[`indexes.${i}.columns`] = 'List the columns separated by commas, e.g. email, name.';
    else if (parts.some((p) => p.length !== null)) errors[`indexes.${i}.columns`] = 'PostgreSQL indexes have no prefix lengths.';
    else {
      const unknown = parts.find((p) => !names.has(p.name.toLowerCase()));
      if (unknown) errors[`indexes.${i}.columns`] = `There is no column “${unknown.name}”.`;
    }
  });
  if (primaries > 1) errors['indexes'] = 'A table can have only one primary key.';

  validateChecks(draft, errors);
  validateForeignKeys(draft, names, errors);
  return errors;
}

function columnListSql(text: string): string {
  return parseColumnList(text)!
    .map((p) => `${quote(p.name)}${p.order ? ` ${p.order}` : ''}`)
    .join(', ');
}

/** `table` or `schema.table`; the table's own schema when none is named. */
function refTableSql(s: TableStructure, text: string): string {
  const [first, second] = text.split('.').map((p) => p.trim().replace(/^"|"$/g, ''));
  return second ? `${quote(first!)}.${quote(second)}` : `${quote(s.schema ?? 'public')}.${quote(first!)}`;
}

/** ALTER COLUMN clauses for what changed in an existing column, in an order PostgreSQL accepts. */
function columnClauses(old: ColumnDraft, d: ColumnDraft): string[] {
  const name = quote(d.name.trim());
  const type = d.type.trim();
  const clauses: string[] = [];
  if (type !== old.type.trim()) clauses.push(`ALTER COLUMN ${name} TYPE ${type} USING ${name}::${type}`);
  if (old.autoIncrement && !d.autoIncrement) clauses.push(`ALTER COLUMN ${name} DROP IDENTITY`);
  const value = d.defaultSql.trim();
  if (value !== old.defaultSql.trim()) clauses.push(value ? `ALTER COLUMN ${name} SET DEFAULT ${value}` : `ALTER COLUMN ${name} DROP DEFAULT`);
  if (d.nullable !== old.nullable) clauses.push(`ALTER COLUMN ${name} ${d.nullable ? 'DROP' : 'SET'} NOT NULL`);
  if (!old.autoIncrement && d.autoIncrement) clauses.push(`ALTER COLUMN ${name} ADD GENERATED BY DEFAULT AS IDENTITY`);
  return clauses;
}

function newColumnDefinition(d: ColumnDraft): string {
  const parts = [quote(d.name.trim()), d.type.trim()];
  if (!d.nullable) parts.push('NOT NULL');
  if (d.defaultSql.trim()) parts.push(`DEFAULT ${d.defaultSql.trim()}`);
  if (d.autoIncrement) parts.push('GENERATED BY DEFAULT AS IDENTITY');
  return parts.join(' ');
}

/**
 * The statements for the draft, in the order they must run: plain indexes and constraints are dropped first, then
 * columns; renames follow, then column changes, new columns and constraints, new indexes and comments.
 */
export function buildPostgresAlterTable(s: TableStructure, draft: StructureDraft): string[] {
  const table = qualifiedTableName(s);
  const before = postgresDraftOf(s);
  const rename = renames(draft);
  const changedIndex = (d: IndexDraft) => indexChanged(before, d, rename);
  const info = (name: string | null) => s.indexes.find((i) => i.name === name);
  const statements: string[] = [];
  const alter = (clauses: string[]) => {
    if (clauses.length) statements.push(`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`);
  };

  const indexDrops: string[] = [];
  const drops: string[] = [];
  for (const fk of draft.foreignKeys) {
    if (fk.original !== null && (fk.dropped || foreignKeyChanged(before, fk, rename))) drops.push(`DROP CONSTRAINT ${quote(fk.original)}`);
  }
  for (const check of draft.checks) {
    if (check.original !== null && (check.dropped || checkChanged(before, check))) drops.push(`DROP CONSTRAINT ${quote(check.original)}`);
  }
  for (const index of draft.indexes) {
    if (index.original === null || !(index.dropped || changedIndex(index))) continue;
    // An index behind a PRIMARY KEY or UNIQUE constraint goes with the constraint.
    if (info(index.original)?.constraint) drops.push(`DROP CONSTRAINT ${quote(index.original)}`);
    else indexDrops.push(`DROP INDEX ${quote(s.schema ?? 'public')}.${quote(index.original)}`);
  }
  for (const column of draft.columns) {
    if (column.original !== null && column.dropped) drops.push(`DROP COLUMN ${quote(column.original)}`);
  }
  statements.push(...indexDrops);
  alter(drops);

  for (const column of draft.columns) {
    if (column.original !== null && !column.dropped && column.name.trim() !== column.original) {
      statements.push(`ALTER TABLE ${table} RENAME COLUMN ${quote(column.original)} TO ${quote(column.name.trim())}`);
    }
  }

  const clauses: string[] = [];
  const indexCreates: string[] = [];
  const comments: string[] = [];
  for (const column of draft.columns) {
    if (column.dropped) continue;
    const old = before.columns.find((c) => c.original === column.original);
    if (!old) clauses.push(`ADD COLUMN ${newColumnDefinition(column)}`);
    else if (columnChanged(before, column)) clauses.push(...columnClauses(old, column));
    if (column.comment !== (old?.comment ?? '')) {
      const text = column.comment ? pgQuoteString(column.comment) : 'NULL';
      comments.push(`COMMENT ON COLUMN ${table}.${quote(column.name.trim())} IS ${text}`);
    }
  }
  for (const index of draft.indexes) {
    if (index.dropped || (index.original !== null && !changedIndex(index))) continue;
    const columns = columnListSql(index.columns);
    const original = info(index.original);
    const name = quote(index.name.trim());
    if (index.kind === 'PRIMARY') clauses.push(`ADD CONSTRAINT ${name} PRIMARY KEY (${columns})`);
    // New unique keys become constraints, which other tables can reference; a plain unique index stays one.
    else if (index.kind === 'UNIQUE' && (!original || original.constraint)) clauses.push(`ADD CONSTRAINT ${name} UNIQUE (${columns})`);
    else {
      const method = original?.method && original.method !== 'btree' && index.kind === 'INDEX' ? ` USING ${original.method}` : '';
      indexCreates.push(`CREATE ${index.kind === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${name} ON ${table}${method} (${columns})`);
    }
  }
  for (const check of draft.checks) {
    if (check.dropped || (check.original !== null && !checkChanged(before, check))) continue;
    clauses.push(`ADD CONSTRAINT ${quote(check.name.trim())} CHECK (${check.clause.trim()})`);
  }
  for (const fk of draft.foreignKeys) {
    if (fk.dropped || (fk.original !== null && !foreignKeyChanged(before, fk, rename))) continue;
    clauses.push(
      `ADD CONSTRAINT ${quote(fk.name.trim())} FOREIGN KEY (${columnListSql(fk.columns)}) REFERENCES ${refTableSql(s, fk.refTable)} (${columnListSql(fk.refColumns)}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`,
    );
  }
  alter(clauses);
  statements.push(...indexCreates, ...comments);
  return statements;
}

/** How many rows of the draft differ from the table. */
export function countPostgresDraftChanges(s: TableStructure, draft: StructureDraft): number {
  const before = postgresDraftOf(s);
  const rename = renames(draft);
  return (
    changedRows(draft.checks, (c) => checkChanged(before, c)) +
    changedRows(draft.columns, (c) => columnChanged(before, c)) +
    changedRows(draft.indexes, (i) => indexChanged(before, i, rename)) +
    changedRows(draft.foreignKeys, (f) => foreignKeyChanged(before, f, rename))
  );
}
