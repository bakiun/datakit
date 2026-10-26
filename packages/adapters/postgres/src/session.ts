import { performance } from 'node:perf_hooks';
import type { SshTunnel } from '@datakit/adapter-common';
import {
  orderSchemas,
  type DatabaseObjects,
  type ObjectMatch,
  type PgObjectKind,
  type PgSchemaObjects,
  type PostgresSession,
  type ResultField,
  type ServerNotice,
  type ServerVersion,
  type SqlStatement,
  type StatementResult,
  type TableStructure,
} from '@datakit/core';
import pg, { type FieldDef, type QueryResult } from 'pg';
import Cursor from 'pg-cursor';
import { definition, describeTable, listSchemaObjects, searchObjects, type Query } from './catalog';
import { formatStatement, TEXT_TYPES } from './values';

const SAVEPOINT = 'datakit_write';
const EXPLAIN_SAVEPOINT = 'datakit_explain';
/** Rows a streamed query reads per round trip. */
const STREAM_BATCH = 200;

interface TypeName {
  name: string;
  /** `pg_type.typcategory`: `N` numeric, `A` array, `B` boolean… */
  category: string;
}

interface ColumnSource {
  schema: string;
  table: string;
  column: string;
}

/** A pg client connected to one database. */
export class PgSession implements PostgresSession {
  readonly kind = 'sql';
  readonly dialect = 'postgres';
  private ended = false;
  private closing = false;
  private readonly listeners: ((error?: Error) => void)[] = [];
  private readonly noticeListeners: ((notice: ServerNotice) => void)[] = [];
  /** Names of the types and table columns that result columns name by oid; they do not change while connected. */
  private readonly typeNames = new Map<number, TypeName>();
  private readonly sources = new Map<string, ColumnSource | null>();
  private readonly query: Query = async <T>(sql: string, values: unknown[] = []) => (await this.client.query(sql, values)).rows as T[];

  constructor(
    private readonly client: pg.Client,
    private readonly tunnel: SshTunnel | undefined,
    readonly serverVersion: ServerVersion,
    readonly database: string,
    /** The backend pid, from `pg_backend_pid()`. */
    readonly connectionId: number,
  ) {
    client.on('error', (error: Error) => this.end(error));
    client.on('end', () => this.end(this.closing ? undefined : new Error('The server closed the connection.')));
    client.on('notice', (message) => {
      const notice = { severity: message.severity ?? 'NOTICE', message: message.message ?? '' };
      for (const listener of this.noticeListeners) listener(notice);
    });
    tunnel?.onDidClose((error) => this.end(error ?? new Error('The SSH tunnel was closed.')));
  }

  /** `E` is a transaction a failed statement aborted; it stays open until it is rolled back. */
  get inTransaction(): boolean {
    const status = this.client.getTransactionStatus();
    return status === 'T' || status === 'E';
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.query<{ name: string }>('SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname');
    return rows.map((r) => r.name);
  }

  async listSchemas(): Promise<string[]> {
    return orderSchemas((await this.query<{ name: string }>('SELECT nspname AS name FROM pg_namespace')).map((r) => r.name));
  }

  listSchemaObjects(schema: string): Promise<PgSchemaObjects> {
    return listSchemaObjects(this.query, schema);
  }

  async listObjects(schema: string): Promise<DatabaseObjects> {
    const objects = await this.listSchemaObjects(schema);
    const names = (routines: { name: string }[]) => [...new Set(routines.map((r) => r.name))];
    return {
      tables: objects.tables,
      views: [...objects.views, ...objects.materializedViews.map((m) => m.name)].sort(),
      procedures: names(objects.procedures),
      functions: names(objects.functions),
    };
  }

  searchObjects(text: string, limit: number): Promise<ObjectMatch[]> {
    return searchObjects(this.query, this.database, text, limit);
  }

  describeTable(schema: string, table: string): Promise<TableStructure> {
    return describeTable(this.query, this.database, schema, table);
  }

  showCreate(schema: string, name: string, kind: TableStructure['kind']): Promise<string> {
    return this.definition(schema, name, kind === 'materializedView' ? 'materializedView' : kind);
  }

  definition(schema: string, name: string, kind: PgObjectKind, args?: string): Promise<string> {
    return definition(this.query, schema, name, kind, args);
  }

  async currentSchema(): Promise<string | null> {
    const [row] = await this.query<{ schema: string | null }>('SELECT current_schema() AS schema');
    return row?.schema ?? null;
  }

  async setSchema(schema: string): Promise<void> {
    const path = schema === 'public' ? 'public' : `${pg.escapeIdentifier(schema)}, public`;
    await this.client.query(`SELECT set_config('search_path', $1, false)`, [path]);
  }

  async execute(sql: string): Promise<StatementResult> {
    const started = performance.now();
    const result = (await this.client.query({ text: sql, rowMode: 'array', types: TEXT_TYPES })) as QueryResult<unknown[]> | QueryResult<unknown[]>[];
    const durationMs = performance.now() - started;
    // A text with several statements returns a result for each; the last one with rows is shown, as for MySQL's CALL.
    const results = Array.isArray(result) ? result : [result];
    const shown = [...results].reverse().find((r) => r.fields.length > 0);
    if (shown) return { kind: 'rows', fields: await this.resultFields(shown.fields), rows: shown.rows, durationMs };
    return { kind: 'ok', affectedRows: results.at(-1)?.rowCount ?? 0, durationMs };
  }

  async explain(statement: string, analyze: boolean): Promise<StatementResult> {
    const sql = `EXPLAIN ${analyze ? '(ANALYZE, BUFFERS) ' : ''}${statement}`;
    if (!analyze) return this.execute(sql);
    // ANALYZE runs the statement; whatever it changes is rolled back.
    const startedHere = !this.inTransaction;
    await this.client.query(startedHere ? 'BEGIN' : `SAVEPOINT ${EXPLAIN_SAVEPOINT}`);
    try {
      return await this.execute(sql);
    } finally {
      await this.client.query(startedHere ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${EXPLAIN_SAVEPOINT}`).catch(() => undefined);
    }
  }

  async write(statements: readonly SqlStatement[], commit: boolean): Promise<number[]> {
    const startedHere = !this.inTransaction;
    if (startedHere) await this.client.query('BEGIN');
    // A savepoint lets a failed write inside an open transaction undo only itself.
    await this.client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const affected: number[] = [];
      for (const statement of statements) {
        const result = await this.client.query({ text: statement.sql, values: statement.params as unknown[] });
        const rows = result.rowCount ?? 0;
        if (statement.expectedRows !== undefined && rows !== statement.expectedRows) {
          throw new Error(
            `A row was changed or deleted by someone else since it was loaded (${rows} of ${statement.expectedRows} rows matched). Nothing was written.`,
          );
        }
        affected.push(rows);
      }
      if (commit) await this.commit();
      else await this.client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return affected;
    } catch (error) {
      if (startedHere) await this.rollback().catch(() => undefined);
      else await this.client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).catch(() => undefined);
      throw error;
    }
  }

  async streamRows(
    sql: string,
    onFields: (fields: ResultField[]) => Promise<void> | void,
    onRow: (row: unknown[]) => Promise<void> | void,
  ): Promise<number> {
    // The query timeout is for statements typed in a view; a long export reads on as long as it takes.
    const [timeout] = await this.query<{ value: string }>(`SELECT current_setting('statement_timeout') AS value`);
    await this.client.query(`SELECT set_config('statement_timeout', '0', false)`);
    const cursor = this.client.query(new Cursor(sql, undefined, { rowMode: 'array', types: TEXT_TYPES }));
    // A cursor that has ended hands over no result, only an empty batch.
    const read = () =>
      new Promise<{ rows: unknown[][]; fields: FieldDef[] }>((resolve, reject) =>
        cursor.read(STREAM_BATCH, (error, rows, result: QueryResult | undefined) =>
          error ? reject(error) : resolve({ rows: rows as unknown[][], fields: result?.fields ?? [] }),
        ),
      );
    let count = 0;
    try {
      for (let first = true; ; first = false) {
        const { rows, fields } = await read();
        // The connection is busy with the cursor, so type names come from what earlier queries looked up.
        if (first) await onFields(fields.map((f) => this.resultField(f)));
        if (!rows.length) break;
        for (const row of rows) {
          await onRow(row);
          count++;
        }
      }
    } finally {
      await cursor.close().catch(() => undefined);
      await this.client.query(`SELECT set_config('statement_timeout', $1, false)`, [timeout?.value ?? '0']).catch(() => undefined);
    }
    return count;
  }

  async begin(): Promise<void> {
    await this.client.query('BEGIN');
  }

  async commit(): Promise<void> {
    await this.client.query('COMMIT');
  }

  async rollback(): Promise<void> {
    await this.client.query('ROLLBACK');
  }

  async stopQuery(connectionId: number): Promise<void> {
    await this.client.query('SELECT pg_cancel_backend($1)', [connectionId]);
  }

  format(statement: SqlStatement): string {
    return formatStatement(statement);
  }

  onNotice(listener: (notice: ServerNotice) => void): void {
    this.noticeListeners.push(listener);
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.closing = true;
    try {
      await this.client.end();
    } catch {
      // The connection is gone already.
    }
    this.end();
  }

  onDidClose(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }

  /** Looks up the type names and table columns of result columns the session has not seen yet. */
  private async resultFields(fields: FieldDef[]): Promise<ResultField[]> {
    const types = [...new Set(fields.map((f) => f.dataTypeID))].filter((oid) => !this.typeNames.has(oid));
    if (types.length) {
      const rows = await this.query<{ oid: string; name: string; category: string }>(
        `SELECT t.oid::text AS oid, CASE WHEN e.oid IS NOT NULL THEN e.typname || '[]' ELSE t.typname END AS name,
                COALESCE(b.typcategory, t.typcategory) AS category
           FROM pg_type t
           LEFT JOIN pg_type e ON e.oid = t.typelem AND t.typcategory = 'A'
           LEFT JOIN pg_type b ON b.oid = t.typbasetype AND t.typtype = 'd'
          WHERE t.oid = ANY($1::oid[])`,
        [types],
      );
      for (const r of rows) this.typeNames.set(Number(r.oid), { name: r.name, category: r.category });
    }
    const columns = fields.filter((f) => f.tableID && !this.sources.has(`${f.tableID}:${f.columnID}`));
    if (columns.length) {
      const rows = await this.query<{ rel: string; num: number; column: string; schema: string; table: string }>(
        `SELECT a.attrelid::text AS rel, a.attnum AS num, a.attname AS column, n.nspname AS schema, c.relname AS table
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE (a.attrelid, a.attnum) IN (SELECT * FROM unnest($1::oid[], $2::int2[]))`,
        [columns.map((f) => f.tableID), columns.map((f) => f.columnID)],
      );
      for (const f of columns) this.sources.set(`${f.tableID}:${f.columnID}`, null);
      for (const r of rows) this.sources.set(`${r.rel}:${r.num}`, { schema: r.schema, table: r.table, column: r.column });
    }
    return fields.map((f) => this.resultField(f));
  }

  private resultField(field: FieldDef): ResultField {
    const type = this.typeNames.get(field.dataTypeID);
    const source = field.tableID ? this.sources.get(`${field.tableID}:${field.columnID}`) : null;
    return {
      name: field.name,
      type: type?.name ?? 'unknown',
      numeric: type?.category === 'N',
      binary: type?.name === 'bytea',
      source: source ? { database: this.database, ...source } : null,
    };
  }

  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.closing) void this.client.end().catch(() => undefined);
    this.tunnel?.close();
    for (const listener of this.listeners) listener(error);
  }
}
