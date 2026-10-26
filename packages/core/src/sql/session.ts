import type { SqlDialect, SqlStatement, TableStructure } from './table';

export interface ServerVersion {
  /** Product name, e.g. `MySQL` or `MariaDB`. */
  product: string;
  /** Numeric version, e.g. `8.0.36`. */
  version: string;
}

export interface TableInfo {
  name: string;
  /** Row estimate from the server's statistics; `null` when unknown. */
  rows: number | null;
}

export interface DatabaseObjects {
  tables: TableInfo[];
  views: string[];
  procedures: string[];
  functions: string[];
}

/** Kinds of objects a name search finds; materialized views, sequences and types are PostgreSQL only. */
export type ObjectKind = 'table' | 'view' | 'materializedView' | 'sequence' | 'procedure' | 'function' | 'type';

/** A table, view or routine found by a name search. */
export interface ObjectMatch {
  database: string;
  /** PostgreSQL: the schema the object is in. */
  schema?: string;
  kind: ObjectKind;
  name: string;
  rows: number | null;
}

/** A column of a result set, with the table column it was read from when the server reports one. */
export interface ResultField {
  name: string;
  /** Type name, e.g. `varchar`. */
  type: string;
  numeric: boolean;
  binary: boolean;
  /** `schema` is set on PostgreSQL, where it qualifies the table. */
  source: { database: string; schema?: string; table: string; column: string } | null;
}

export type StatementResult =
  | {
      kind: 'rows';
      fields: ResultField[];
      /** Values as the driver returns them; the caller converts them for display. */
      rows: unknown[][];
      durationMs: number;
    }
  | { kind: 'ok'; affectedRows: number; durationMs: number };

/** What a MySQL server offers for the Table section of the Structure tab. */
export interface TableOptionChoices {
  engines: string[];
  charsets: { name: string; defaultCollation: string }[];
  collations: { name: string; charset: string }[];
}

/** A message the server sends while a statement runs, e.g. PostgreSQL's `RAISE NOTICE` or a warning. */
export interface ServerNotice {
  /** e.g. `NOTICE`, `WARNING`, `INFO`. */
  severity: string;
  message: string;
}

/** An open connection of any engine; the extension keeps one per data source and opens more for its views. */
export interface ServerSession {
  /** Tells SQL sessions from the Redis, Kafka and MongoDB ones. */
  readonly kind: 'sql' | 'redis' | 'kafka' | 'mongodb';
  readonly serverVersion: ServerVersion;
  close(): Promise<void>;
  /** Called once when the connection ends, with the error if it was lost. */
  onDidClose(listener: (error?: Error) => void): void;
}

/**
 * An open connection to a SQL server, implemented by each SQL adapter. Tables are named by a namespace and a name:
 * on MySQL the namespace is a database; a PostgreSQL session is bound to one database, and its namespaces are the
 * schemas in it.
 */
export interface SqlSession extends ServerSession {
  readonly kind: 'sql';
  readonly dialect: SqlDialect;
  readonly serverVersion: ServerVersion;
  /** The connection's id on the server (the backend pid on PostgreSQL), used to stop its running query from another session. */
  readonly connectionId: number;
  /** True while a transaction is open, whether `begin()`, `write(…, false)` or a script statement opened it. */
  readonly inTransaction: boolean;
  listDatabases(): Promise<string[]>;
  listObjects(namespace: string): Promise<DatabaseObjects>;
  /** Tables, views and routines whose name contains `text`, ignoring case; at most `limit`. */
  searchObjects(text: string, limit: number): Promise<ObjectMatch[]>;
  describeTable(namespace: string, table: string): Promise<TableStructure>;
  showCreate(namespace: string, name: string, kind: TableStructure['kind']): Promise<string>;
  /** Runs one statement as written. */
  execute(sql: string): Promise<StatementResult>;
  /**
   * Runs a query and hands its rows over one at a time, waiting for `onRow` before reading on, so a large
   * result never sits in memory. Returns the number of rows.
   */
  streamRows(
    sql: string,
    onFields: (fields: ResultField[]) => Promise<void> | void,
    onRow: (row: unknown[]) => Promise<void> | void,
  ): Promise<number>;
  /**
   * Runs the statements as one unit and returns the rows each affected. On error, none of them stay applied.
   * With `commit` false the transaction stays open for `commit()` or `rollback()`.
   */
  write(statements: readonly SqlStatement[], commit: boolean): Promise<number[]>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Stops the query running on another connection of the same server. */
  stopQuery(connectionId: number): Promise<void>;
  /** The statement with its parameters written in, for previews and SQL exports. */
  format(statement: SqlStatement): string;
  /** Messages the server sends while statements run; servers without them never call `listener`. */
  onNotice?(listener: (notice: ServerNotice) => void): void;
  close(): Promise<void>;
  /** Called once when the connection ends, with the error if it was lost. */
  onDidClose(listener: (error?: Error) => void): void;
}

export interface ConnectionTestResult {
  serverVersion: ServerVersion;
  latencyMs: number;
}

/** `MySQL 8.0.36` */
export function formatServerVersion(v: ServerVersion): string {
  return `${v.product} ${v.version}`;
}

/** `mysql 8.0`, the compact form shown next to a data source in the tree. */
export function shortServerVersion(v: ServerVersion): string {
  const [major, minor] = v.version.split('.');
  return `${v.product.toLowerCase()} ${minor === undefined ? major : `${major}.${minor}`}`;
}
