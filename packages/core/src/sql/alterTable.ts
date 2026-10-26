import { buildPostgresAlterTable, countPostgresDraftChanges, postgresDraftOf, validatePostgresDraft } from '../postgres/alterTable';
import type { FieldErrors } from '../validation';
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
  type ForeignKeyDraft,
  type IndexDraft,
  type StructureDraft,
  type TableDraft,
} from './structureDraft';
import { quoteIdentifier, type ColumnInfo, type IndexKind, type ReferentialAction, type SqlDialect, type TableStructure } from './table';

/**
 * The ALTER TABLE statements that apply a Structure tab draft. Each function picks the dialect's rules from the
 * table; what follows them here is MySQL and MariaDB. Column definitions are rebuilt from the draft plus what the tab
 * does not show (character set, collation, ON UPDATE, generation, MariaDB column checks), so a changed column keeps those.
 */

export function indexKinds(dialect: SqlDialect): readonly IndexKind[] {
  return dialect === 'postgres' ? ['PRIMARY', 'UNIQUE', 'INDEX'] : ['PRIMARY', 'UNIQUE', 'INDEX', 'FULLTEXT', 'SPATIAL'];
}

export function referentialActions(dialect: SqlDialect): readonly ReferentialAction[] {
  const actions: ReferentialAction[] = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
  return dialect === 'postgres' ? [...actions, 'SET DEFAULT'] : actions;
}

/** PostgreSQL runs DDL in a transaction, so a change set applies whole or not at all; MySQL commits each statement. */
export function hasTransactionalDdl(dialect: SqlDialect): boolean {
  return dialect === 'postgres';
}

const STRING_TYPE = /^\s*(var)?char\b|^\s*(tiny|medium|long)?text\b|^\s*enum\b|^\s*set\b/i;
const quote = (name: string) => quoteIdentifier(name, 'mysql');

/** A MySQL string literal. */
export function quoteString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function indexColumnsText(s: TableStructure, name: string): string {
  const index = s.indexes.find((i) => i.name === name)!;
  return index.columns.map((c, i) => (index.lengths[i] ? `${c}(${index.lengths[i]})` : c)).join(', ');
}

function refTableText(s: TableStructure, database: string, table: string): string {
  return database === s.database ? table : `${database}.${table}`;
}

export function draftOf(s: TableStructure): StructureDraft {
  if (s.dialect === 'postgres') return postgresDraftOf(s);
  const o = s.options;
  return {
    table: o
      ? {
          name: s.table,
          comment: o.comment,
          engine: o.engine,
          charset: o.charset,
          collation: o.collation,
          convert: false,
          autoIncrement: o.autoIncrement === null ? '' : String(o.autoIncrement),
        }
      : null,
    columns: s.columns.map((c) => ({
      original: c.name,
      name: c.name,
      type: c.columnType,
      nullable: c.nullable,
      defaultSql: c.defaultSql ?? '',
      autoIncrement: c.autoIncrement,
      comment: c.comment,
      dropped: false,
    })),
    indexes: s.indexes.map((i) => ({ original: i.name, kind: i.kind, name: i.name, columns: indexColumnsText(s, i.name), dropped: false })),
    foreignKeys: s.foreignKeys.map((f) => ({
      original: f.name,
      name: f.name,
      columns: f.columns.join(', '),
      refTable: refTableText(s, f.refDatabase, f.refTable),
      refColumns: f.refColumns.join(', '),
      onUpdate: f.onUpdate,
      onDelete: f.onDelete,
      dropped: false,
    })),
    checks: s.checks.map((c) => ({ original: c.name, name: c.name, clause: c.clause, dropped: false })),
  };
}

function columnListSql(text: string): string {
  return parseColumnList(text)!
    .map((p) => `${quote(p.name)}${p.length ? `(${p.length})` : ''}${p.order ? ` ${p.order}` : ''}`)
    .join(', ');
}

function refTableSql(s: TableStructure, text: string): string {
  const [first, second] = text.split('.').map((p) => p.trim().replace(/^`|`$/g, ''));
  return second ? `${quote(first!)}.${quote(second)}` : `${quote(s.database)}.${quote(first!)}`;
}

/** Checks the draft; keys are `columns.<i>.name`, `indexes.<i>.columns`, `foreignKeys.<i>.refTable` and so on. */
export function validateDraft(s: TableStructure, draft: StructureDraft): FieldErrors {
  if (s.dialect === 'postgres') return validatePostgresDraft(s, draft);
  const errors: FieldErrors = {};
  const names = validateColumns(draft, errors);

  const indexNames = new Set<string>();
  let primaries = 0;
  draft.indexes.forEach((index, i) => {
    if (index.dropped) return;
    if (index.kind === 'PRIMARY') primaries++;
    else {
      const name = index.name.trim().toLowerCase();
      if (!name) errors[`indexes.${i}.name`] = 'Index name is required.';
      else if (name === 'primary') errors[`indexes.${i}.name`] = 'Only the primary key can be named PRIMARY.';
      else if (indexNames.has(name)) errors[`indexes.${i}.name`] = `Another index is named “${index.name.trim()}”.`;
      indexNames.add(name);
    }
    const parts = parseColumnList(index.columns);
    if (!parts) errors[`indexes.${i}.columns`] = 'List the columns separated by commas, e.g. email, name(10).';
    else {
      const unknown = parts.find((p) => !names.has(p.name.toLowerCase()));
      if (unknown) errors[`indexes.${i}.columns`] = `There is no column “${unknown.name}”.`;
    }
  });
  if (primaries > 1) errors['indexes'] = 'A table can have only one primary key.';

  if (draft.table) {
    if (!draft.table.name.trim()) errors['table.name'] = 'Table name is required.';
    if (!draft.table.engine.trim()) errors['table.engine'] = 'Engine is required.';
    const next = draft.table.autoIncrement.trim();
    if (next && !/^\d+$/.test(next)) errors['table.autoIncrement'] = 'AUTO_INCREMENT must be a whole number.';
  }

  validateChecks(draft, errors);
  validateForeignKeys(draft, names, errors);
  return errors;
}

function columnDefinition(draft: ColumnDraft, original: ColumnInfo | undefined): string {
  const parts = [draft.type.trim()];
  if (original?.generation) {
    parts.push(`GENERATED ALWAYS AS (${original.generation.expression}) ${original.generation.stored ? 'STORED' : 'VIRTUAL'}`);
    parts.push(draft.nullable ? 'NULL' : 'NOT NULL');
  } else {
    if (original?.charset && STRING_TYPE.test(draft.type)) {
      parts.push(`CHARACTER SET ${original.charset}`);
      if (original.collation) parts.push(`COLLATE ${original.collation}`);
    }
    parts.push(draft.nullable ? 'NULL' : 'NOT NULL');
    if (draft.defaultSql.trim()) parts.push(`DEFAULT ${draft.defaultSql.trim()}`);
    if (original?.onUpdate) parts.push(`ON UPDATE ${original.onUpdate}`);
    if (draft.autoIncrement) parts.push('AUTO_INCREMENT');
  }
  if (draft.comment) parts.push(`COMMENT ${quoteString(draft.comment)}`);
  if (original?.check) parts.push(`CHECK (${original.check})`);
  return parts.join(' ');
}

/** Table options that differ from the table, as ALTER TABLE clauses. */
function tableOptionClauses(s: TableStructure, table: TableDraft | null): string[] {
  const o = s.options;
  if (!o || !table) return [];
  const clauses: string[] = [];
  if (table.engine.trim() !== o.engine) clauses.push(`ENGINE = ${table.engine.trim()}`);
  const charset = table.charset.trim();
  const collation = table.collation.trim();
  if (table.convert || charset !== o.charset || collation !== o.collation) {
    const target = `CHARACTER SET ${charset}${collation ? ` COLLATE ${collation}` : ''}`;
    clauses.push(table.convert ? `CONVERT TO ${target}` : `DEFAULT ${target}`);
  }
  if (table.comment !== o.comment) clauses.push(`COMMENT = ${quoteString(table.comment)}`);
  const next = table.autoIncrement.trim();
  if (next && next !== String(o.autoIncrement ?? '')) clauses.push(`AUTO_INCREMENT = ${next}`);
  return clauses;
}

/** Indexes of `values` that are not in a longest increasing run; those columns have to move. */
function outOfOrder(values: number[]): Set<number> {
  const length = values.map(() => 1);
  const previous = values.map(() => -1);
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j]! < values[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1;
        previous[i] = j;
      }
    }
  }
  const keep = new Set<number>();
  let at = length.indexOf(Math.max(0, ...length));
  while (at >= 0) {
    keep.add(at);
    at = previous[at]!;
  }
  return new Set(values.map((_, i) => i).filter((i) => !keep.has(i)));
}

/** The ALTER TABLE statements for the draft; empty when nothing changed. */
export function buildAlterTable(s: TableStructure, draft: StructureDraft): string[] {
  if (s.dialect === 'postgres') return buildPostgresAlterTable(s, draft);
  const table = `${quote(s.database)}.${quote(s.table)}`;
  const before = draftOf(s);
  const clauses: string[] = [];

  const rename = renames(draft);
  const changedIndex = (d: IndexDraft) => indexChanged(before, d, rename);
  const changedForeignKey = (d: ForeignKeyDraft) => foreignKeyChanged(before, d, rename);

  // Foreign keys are dropped and added in statements of their own: MySQL cannot do both with one name at once.
  const fkDrops = draft.foreignKeys
    .filter((f) => f.original !== null && (f.dropped || changedForeignKey(f)))
    .map((f) => `DROP FOREIGN KEY ${quote(f.original!)}`);
  const fkAdds = draft.foreignKeys
    .filter((f) => !f.dropped && (f.original === null || changedForeignKey(f)))
    .map(
      (f) =>
        `ADD CONSTRAINT ${quote(f.name.trim())} FOREIGN KEY (${columnListSql(f.columns)}) REFERENCES ${refTableSql(s, f.refTable)} (${columnListSql(f.refColumns)}) ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`,
    );

  for (const index of draft.indexes) {
    if (index.original === null || !(index.dropped || changedIndex(index))) continue;
    clauses.push(index.original === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${quote(index.original)}`);
  }
  for (const check of draft.checks) {
    if (check.original === null || !(check.dropped || checkChanged(before, check))) continue;
    clauses.push(`${s.dialect === 'mariadb' ? 'DROP CONSTRAINT' : 'DROP CHECK'} ${quote(check.original)}`);
  }
  for (const column of draft.columns) {
    if (column.original !== null && column.dropped) clauses.push(`DROP COLUMN ${quote(column.original)}`);
  }

  const kept = draft.columns.filter((c) => !c.dropped);
  const originalOrder = s.columns.map((c) => c.name);
  const existing = kept.filter((c) => c.original !== null);
  const moved = outOfOrder(existing.map((c) => originalOrder.indexOf(c.original!)));
  kept.forEach((column, i) => {
    const position = i === 0 ? ' FIRST' : ` AFTER ${quote(kept[i - 1]!.name.trim())}`;
    const original = s.columns.find((c) => c.name === column.original);
    const definition = columnDefinition(column, original);
    if (column.original === null) {
      clauses.push(`ADD COLUMN ${quote(column.name.trim())} ${definition}${position}`);
      return;
    }
    const isMoved = moved.has(existing.indexOf(column));
    if (isMoved || columnChanged(before, column)) {
      clauses.push(`CHANGE COLUMN ${quote(column.original)} ${quote(column.name.trim())} ${definition}${isMoved ? position : ''}`);
    }
  });

  for (const index of draft.indexes) {
    if (index.dropped || (index.original !== null && !changedIndex(index))) continue;
    const columns = columnListSql(index.columns);
    if (index.kind === 'PRIMARY') clauses.push(`ADD PRIMARY KEY (${columns})`);
    else {
      const kind = index.kind === 'INDEX' ? '' : `${index.kind} `;
      clauses.push(`ADD ${kind}INDEX ${quote(index.name.trim())} (${columns})`);
    }
  }

  for (const check of draft.checks) {
    if (check.dropped || (check.original !== null && !checkChanged(before, check))) continue;
    clauses.push(`ADD CONSTRAINT ${quote(check.name.trim())} CHECK (${check.clause.trim()})`);
  }

  // Table options come after the column changes, so CONVERT TO also converts columns changed above.
  const statement = (parts: string[]) => `ALTER TABLE ${table}\n  ${parts.join(',\n  ')}`;
  const statements = [fkDrops, clauses, tableOptionClauses(s, draft.table), fkAdds].filter((parts) => parts.length).map(statement);
  const newName = draft.table?.name.trim();
  if (newName && newName !== s.table) {
    statements.push(`RENAME TABLE ${table} TO ${quote(s.database)}.${quote(newName)}`);
  }
  return statements;
}

/** How many rows of the draft differ from the table; the table's own settings and a changed column order count once each. */
export function countDraftChanges(s: TableStructure, draft: StructureDraft): number {
  if (s.dialect === 'postgres') return countPostgresDraftChanges(s, draft);
  const before = draftOf(s);
  const order = draft.columns.filter((c) => !c.dropped && c.original !== null).map((c) => c.original);
  const reordered = order.join('\n') !== s.columns.map((c) => c.name).filter((n) => order.includes(n)).join('\n');
  const table = draft.table && (tableOptionClauses(s, draft.table).length || draft.table.name.trim() !== s.table) ? 1 : 0;
  return (
    table +
    changedRows(draft.checks, (c) => checkChanged(before, c)) +
    changedRows(draft.columns, (c) => columnChanged(before, c)) +
    changedRows(draft.indexes, (i) => indexChanged(before, i, renames(draft))) +
    changedRows(draft.foreignKeys, (f) => foreignKeyChanged(before, f, renames(draft))) +
    (reordered ? 1 : 0)
  );
}
