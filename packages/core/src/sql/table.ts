/** Table metadata and the SQL behind the data view: paged SELECTs and the statements that write grid edits. */

/**
 * The SQL flavour a statement is written in. MySQL and MariaDB differ only in details of their DDL; PostgreSQL quotes
 * identifiers with double quotes, numbers its parameters (`$1`) and keeps tables in schemas inside a database.
 */
export type SqlDialect = 'mysql' | 'mariadb' | 'postgres';

export interface ColumnInfo {
  name: string;
  /** Type as the server shows it, e.g. `varchar(255)` or `enum('a','b')`. */
  columnType: string;
  /** Base type, e.g. `varchar`. */
  dataType: string;
  nullable: boolean;
  /** `COLUMN_DEFAULT` as text; `null` when there is none (or it is NULL). */
  defaultValue: string | null;
  /** `PRI`, `UNI`, `MUL` or empty. */
  key: string;
  /** e.g. `auto_increment`, `DEFAULT_GENERATED`, `VIRTUAL GENERATED`. */
  extra: string;
  /** The server numbers new rows: AUTO_INCREMENT on MySQL, an identity column or a sequence default on PostgreSQL. */
  autoIncrement: boolean;
  /** Generated columns are computed by the server and cannot be written; nor can PostgreSQL's GENERATED ALWAYS identities. */
  generated: boolean;
  numeric: boolean;
  binary: boolean;
  /** Allowed values of an ENUM column; on PostgreSQL also of an enum type, and `true`/`false` for booleans. */
  enumValues: string[] | null;
  /** The default as SQL, e.g. `'pending'`, `0`, `NULL`, `CURRENT_TIMESTAMP` or `(uuid())`; null when there is none. */
  defaultSql: string | null;
  comment: string;
  charset: string | null;
  collation: string | null;
  /** The value of `ON UPDATE`, e.g. `CURRENT_TIMESTAMP`. */
  onUpdate: string | null;
  /** Expression and storage of a generated column. */
  generation: { expression: string; stored: boolean } | null;
  /** MariaDB keeps a CHECK written on a column with the column; it is part of the column's definition. */
  check: string | null;
  /** PostgreSQL: how an identity column numbers rows; null for other columns. Not set on MySQL. */
  identity?: 'always' | 'by default' | null;
}

export type IndexKind = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL';

export interface IndexInfo {
  name: string;
  kind: IndexKind;
  unique: boolean;
  /** Column names; on PostgreSQL an expression stands in for the column of an expression index. */
  columns: string[];
  /** Prefix length of each column, e.g. 10 for `name(10)`. */
  lengths: (number | null)[];
  /** PostgreSQL: the index backs a PRIMARY KEY, UNIQUE or EXCLUDE constraint of the same name. */
  constraint?: boolean;
  /** PostgreSQL: the access method, e.g. `btree` or `gin`. */
  method?: string;
  /** PostgreSQL: the CREATE INDEX statement, from `pg_get_indexdef`. */
  definition?: string;
}

/** `SET DEFAULT` is PostgreSQL only. */
export type ReferentialAction = 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'NO ACTION' | 'SET DEFAULT';

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refDatabase: string;
  /** PostgreSQL: the schema of the referenced table. Not set on MySQL. */
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onUpdate: ReferentialAction;
  onDelete: ReferentialAction;
}

export interface TableOptions {
  comment: string;
  engine: string;
  charset: string;
  collation: string;
  /** The next AUTO_INCREMENT value; null when the table has no such counter. */
  autoIncrement: number | null;
}

export interface CheckInfo {
  name: string;
  /** The condition, as the server shows it. */
  clause: string;
}

export interface TableStructure {
  /** Decides the details of the generated SQL. */
  dialect: SqlDialect;
  database: string;
  /** PostgreSQL: the schema the table is in. Not set on MySQL, where the database qualifies the table. */
  schema?: string;
  table: string;
  kind: 'table' | 'view' | 'materializedView';
  /** MySQL table options; null for views and on PostgreSQL. */
  options: TableOptions | null;
  checks: CheckInfo[];
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  /** Columns that identify a row: the primary key, else a unique key on NOT NULL columns. Empty when there is none. */
  rowKey: string[];
}

export interface SortKey {
  column: string;
  direction: 'asc' | 'desc';
}

export interface PageRequest {
  /** SQL condition typed by the user; empty for none. */
  where: string;
  sort: SortKey[];
  limit: number;
  offset: number;
}

/** A value as shown in the grid. Binary values carry a hex preview. */
export type CellValue = string | number | null | BinaryValue;

export interface BinaryValue {
  hex: string;
  length: number;
}

export function isBinaryValue(value: CellValue): value is BinaryValue {
  return typeof value === 'object' && value !== null;
}

/** Grid edits. Existing rows are referred to by their index on the loaded page. */
export type TableChange =
  | { kind: 'update'; row: number; values: Record<string, string | null> }
  | { kind: 'insert'; values: Record<string, string | null> }
  | { kind: 'delete'; row: number };

export interface SqlStatement {
  sql: string;
  params: unknown[];
  /** Rows the statement must affect; a different count undoes the whole write. */
  expectedRows?: number;
}

const NUMERIC_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double', 'real', 'year']);
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit', 'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection']);

export function isNumericType(dataType: string): boolean {
  return NUMERIC_TYPES.has(dataType.toLowerCase());
}

export function isBinaryType(dataType: string): boolean {
  return BINARY_TYPES.has(dataType.toLowerCase());
}

/** Values of `enum('a','b''c')`. */
export function parseEnumValues(columnType: string): string[] | null {
  const match = /^enum\((.*)\)$/is.exec(columnType.trim());
  if (!match) return null;
  return [...match[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
}

/** `` `name` `` on MySQL and MariaDB, `"name"` on PostgreSQL. */
export function quoteIdentifier(name: string, dialect: SqlDialect): string {
  return dialect === 'postgres' ? `"${name.replace(/"/g, '""')}"` : `\`${name.replace(/`/g, '``')}\``;
}

/** The placeholder of a statement's parameter, counted from 1: `?` on MySQL, `$1` on PostgreSQL. */
export function sqlParameter(dialect: SqlDialect, position: number): string {
  return dialect === 'postgres' ? `$${position}` : '?';
}

/** The name that qualifies a table in SQL: its database on MySQL, its schema on PostgreSQL. */
export function tableNamespace(s: Pick<TableStructure, 'database' | 'schema'>): string {
  return s.schema ?? s.database;
}

/** `` `shop`.`orders` `` or `"public"."orders"`. */
export function qualifiedTableName(s: TableStructure): string {
  return `${quoteIdentifier(tableNamespace(s), s.dialect)}.${quoteIdentifier(s.table, s.dialect)}`;
}

/** The SELECT shown above the grid and run for it, one clause per line. */
export function buildSelect(s: TableStructure, page: PageRequest): string {
  const lines = ['SELECT *', `FROM ${qualifiedTableName(s)}`];
  if (page.where.trim()) lines.push(`WHERE ${page.where.trim()}`);
  if (page.sort.length) {
    lines.push(`ORDER BY ${page.sort.map((k) => `${quoteIdentifier(k.column, s.dialect)} ${k.direction.toUpperCase()}`).join(', ')}`);
  }
  lines.push(`LIMIT ${Math.trunc(page.limit)} OFFSET ${Math.trunc(page.offset)};`);
  return lines.join('\n');
}

export function buildCount(s: TableStructure, where: string): string {
  return `SELECT COUNT(*) AS total FROM ${qualifiedTableName(s)}${where.trim() ? ` WHERE ${where.trim()}` : ''}`;
}

/** Why the grid of a table cannot be edited, or null when it can. */
export function readOnlyReason(s: TableStructure): string | null {
  if (s.kind === 'view') return 'Views are shown read-only.';
  if (s.kind === 'materializedView') return 'Materialized views are read-only; refresh them to update their rows.';
  if (!s.rowKey.length) return 'Read-only: the table has no primary key or unique key to identify rows.';
  return null;
}

/** Whether a column can be written from the grid. Key columns of existing rows stay as they are. */
export function isEditableColumn(column: ColumnInfo, rowKey: readonly string[], existingRow: boolean): boolean {
  if (column.generated || column.binary) return false;
  if (existingRow && rowKey.includes(column.name)) return false;
  return true;
}

/**
 * Statements for grid edits, with parameters: `?` on MySQL; `$1`, `$2`… on PostgreSQL, where the server reads each
 * value as the type of the column it is compared with or written to. `keyOf(row)` returns the row key values of a
 * loaded row. UPDATE and DELETE must affect exactly one row; on MySQL they are also limited to one.
 */
export function buildChanges(s: TableStructure, changes: readonly TableChange[], keyOf: (row: number) => unknown[]): SqlStatement[] {
  const table = qualifiedTableName(s);
  const quote = (name: string) => quoteIdentifier(name, s.dialect);
  const postgres = s.dialect === 'postgres';
  const limit = postgres ? '' : ' LIMIT 1';
  return changes.map((change): SqlStatement => {
    let count = 0;
    const param = () => sqlParameter(s.dialect, ++count);
    if (change.kind === 'insert') {
      const columns = Object.keys(change.values);
      if (!columns.length) return { sql: postgres ? `INSERT INTO ${table} DEFAULT VALUES` : `INSERT INTO ${table} () VALUES ()`, params: [] };
      return {
        sql: `INSERT INTO ${table} (${columns.map(quote).join(', ')}) VALUES (${columns.map(param).join(', ')})`,
        params: columns.map((c) => change.values[c]),
      };
    }
    if (change.kind === 'delete') {
      const where = s.rowKey.map((c) => `${quote(c)} = ${param()}`).join(' AND ');
      return { sql: `DELETE FROM ${table} WHERE ${where}${limit}`, params: keyOf(change.row), expectedRows: 1 };
    }
    const columns = Object.keys(change.values);
    const set = columns.map((c) => `${quote(c)} = ${param()}`).join(', ');
    const where = s.rowKey.map((c) => `${quote(c)} = ${param()}`).join(' AND ');
    return {
      sql: `UPDATE ${table} SET ${set} WHERE ${where}${limit}`,
      params: [...columns.map((c) => change.values[c]), ...keyOf(change.row)],
      expectedRows: 1,
    };
  });
}

/** “2 updated · 1 inserted · 1 deleted” */
export function describeChanges(changes: readonly TableChange[]): string {
  const count = (kind: TableChange['kind']) => changes.filter((c) => c.kind === kind).length;
  const parts = [
    [count('update'), 'updated'],
    [count('insert'), 'inserted'],
    [count('delete'), 'deleted'],
  ].filter(([n]) => n) as [number, string][];
  return parts.length ? parts.map(([n, label]) => `${n} ${label}`).join(' · ') : 'no changes';
}
