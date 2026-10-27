import type { Environment } from '../dataSource';
import type { CellValue, ColumnInfo, SqlDialect, TableChange, TableStructure } from '../sql/table';

/** Messages between the extension and the SQL views: the data view of a table and the query console. */

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx' | 'markdown';

export const EXPORT_FORMATS: readonly { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL INSERT' },
  { value: 'xlsx', label: 'Excel' },
  { value: 'markdown', label: 'Markdown' },
];

export const DATA_PAGE_SIZES = [10, 25, 50, 100, 500] as const;

/** A statement of the script, with its place in the editor so its ORDER BY and LIMIT can be rewritten. */
export interface ScriptStatement {
  text: string;
  from: number;
  to: number;
  /** For queries: the statement without ORDER BY and LIMIT, for counting all its rows. */
  unpaged?: string;
  /** For queries: the statement without LIMIT, for exporting all its rows in order. */
  unlimited?: string;
}

export type ExportScope = 'page' | 'all';

export interface ResultColumn {
  name: string;
  /** Type shown in the header, e.g. `varchar`. */
  type: string;
  numeric: boolean;
  binary: boolean;
  /** The table column behind it when the rows can be edited. */
  column: ColumnInfo | null;
}

/** What a query console starts with. */
export interface ConsoleInit {
  /** File name of the console, e.g. `console-1.sql`. */
  name: string;
  /** The database statements run in; null when none is selected. On PostgreSQL the database the console is connected to. */
  database: string | null;
  databases: string[];
  /** PostgreSQL: the schema unqualified names resolve to, and the schemas of the database. Not set on MySQL. */
  schema?: string | null;
  schemas?: string[];
}

export interface TableDataInit {
  dataSourceName: string;
  environment: Environment;
  /** Product and version, e.g. `MySQL 8.4.3`. */
  serverLabel: string;
  /** `MySQL`, `MariaDB` or `PostgreSQL`, as the server names itself. */
  product: string;
  /** Picks the editor's SQL grammar, the identifier quotes and how statements are split. */
  dialect: SqlDialect;
  /** Set for a read-only data source. */
  readOnly: boolean;
  /** The table of a data view; null in a query console. */
  structure: TableStructure | null;
  /** Set for a query console. */
  console: ConsoleInit | null;
  pageSize: number;
  /** The script the editor starts with. */
  script: string;
  /** Height of the SQL editor the user last chose, in pixels. */
  editorHeight: number | null;
  /** Tables of the database, suggested for foreign key targets and completed in the editor. */
  tables: string[];
  autoCommit: boolean;
  /** The export format and rows the user picked last, in any SQL view. */
  exportFormat: ExportFormat;
  exportScope: ExportScope;
}

export interface LoadedPage {
  /** The statement the rows come from. */
  statement: ScriptStatement;
  columns: ResultColumn[];
  rows: CellValue[][];
  /** All rows of the query; null when they could not be counted. */
  total: number | null;
  durationMs: number;
  /** The table the rows are written back to, with its key columns; null when the result is read-only. */
  editable: { database: string; schema?: string; table: string; rowKey: string[] } | null;
  readOnlyReason: string | null;
}

export type LogLevel = 'info' | 'ok' | 'warning' | 'error';

export type TableDataHostMessage =
  | { type: 'init'; init: TableDataInit }
  /** `connection` is set when the data source could not be connected to, so the page offers to edit it. */
  | { type: 'initFailed'; message: string; connection?: boolean }
  /** `summary` describes the other statements of a run, or the edit that was just written. */
  | { type: 'page'; page: LoadedPage; summary?: string }
  /** A run without a statement that returns rows. */
  | { type: 'ran'; summary: string }
  /** `failed` is where the failing statement is in the editor. */
  | { type: 'runFailed'; message: string; summary?: string; failed?: { from: number; to: number } }
  | { type: 'submitFailed'; message: string }
  /**
   * The user declined the production confirmation of a run, a write or a structure change; nothing was done.
   * Not an error: the view only stops waiting and says so quietly.
   */
  | { type: 'declined'; message: string }
  /** Whether a transaction is open, and how many writes it holds. */
  | { type: 'transaction'; open: boolean; changes: number }
  | { type: 'notice'; message: string }
  /** The table after a structure change was applied. */
  | { type: 'structure'; structure: TableStructure; summary: string }
  | { type: 'alterFailed'; message: string }
  /** A line for the console's Messages tab. */
  | { type: 'log'; level: LogLevel; text: string }
  /** The console now runs statements in `database`; on PostgreSQL also in `schema`, one of `schemas`. */
  | { type: 'database'; database: string; tables: string[]; schema?: string; schemas?: string[] }
  /** EXPLAIN output for the console's Execution Plan tab. */
  | { type: 'plan'; statement: string; columns: ResultColumn[]; rows: CellValue[][] }
  | { type: 'planFailed'; message: string }
  /** Console: adds a statement at the end of the script, e.g. one picked from the query history. */
  | { type: 'insertScript'; text: string };

export type TableDataWebviewMessage =
  | { type: 'ready' }
  /**
   * Runs the statements in order; the rows of the last one that returns rows are shown. `record: false` keeps
   * them out of the query history, e.g. the query a data view opens with.
   */
  | { type: 'run'; statements: ScriptStatement[]; autoCommit: boolean; record?: boolean }
  /** Runs one query again, e.g. after its ORDER BY or LIMIT changed. */
  | { type: 'query'; statement: ScriptStatement }
  | { type: 'submit'; changes: TableChange[]; autoCommit: boolean; statement: ScriptStatement }
  | { type: 'commit'; statement: ScriptStatement | null }
  | { type: 'rollback'; statement: ScriptStatement | null }
  | { type: 'stop' }
  | { type: 'export'; format: ExportFormat; scope: ExportScope }
  | { type: 'copySql'; sql: string }
  | { type: 'viewDdl' }
  /** The Tx select changed; shown in the status bar. */
  | { type: 'txMode'; autoCommit: boolean }
  /** The user resized the SQL editor; every data view opens with this height. */
  | { type: 'editorHeight'; height: number }
  /** The user picked a page size in the grid; the SQL views of the data source open with it. */
  | { type: 'pageSize'; pageSize: number }
  /** ALTER TABLE statements built from the Structure tab. */
  | { type: 'alterTable'; statements: string[] }
  /** Opens the data source's settings, e.g. after the view could not connect. */
  | { type: 'editDataSource' }
  /** Data view: opens a new query console with this script. */
  | { type: 'openConsole'; script: string }
  /** Console: the editor text changed; it is saved to the console's file. */
  | { type: 'script'; script: string }
  /** Console: runs the next statements in another database; on PostgreSQL the console reconnects to it. */
  | { type: 'useDatabase'; database: string }
  /** Console (PostgreSQL): resolves unqualified names in another schema first. */
  | { type: 'useSchema'; schema: string }
  /**
   * Console: shows how the server would run a statement. `analyze` (PostgreSQL) runs it to measure it, in a
   * transaction that is rolled back.
   */
  | { type: 'explain'; statement: string; analyze?: boolean };
