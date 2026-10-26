import { performance } from 'node:perf_hooks';
import type { SshTunnel } from '@datakit/adapter-common';
import {
  isBinaryType,
  isNumericType,
  parseEnumValues,
  quoteIdentifier,
  type CheckInfo,
  type ColumnInfo,
  type DatabaseObjects,
  type ForeignKeyInfo,
  type IndexInfo,
  type ObjectKind,
  type ObjectMatch,
  type ReferentialAction,
  type ResultField,
  type ServerVersion,
  type SqlDialect,
  type SqlSession,
  type SqlStatement,
  type StatementResult,
  type TableOptionChoices,
  type TableStructure,
} from '@datakit/core';
import type { Connection as CoreConnection } from 'mysql2';
import mysql, { type Connection, type FieldPacket, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { defaultSql } from './defaults';

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/** information_schema text columns may arrive as buffers, depending on the server. */
const text = (value: unknown): string => (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''));

const SAVEPOINT = 'datakit_write';

/** Bit of the server status in OK packets that says a transaction is open. */
const SERVER_STATUS_IN_TRANS = 0x0001;
/** Character set number of binary strings. */
const BINARY_CHARSET = 63;

const TYPE_NAMES: Record<number, string> = {
  0x00: 'decimal',
  0x01: 'tinyint',
  0x02: 'smallint',
  0x03: 'int',
  0x04: 'float',
  0x05: 'double',
  0x07: 'timestamp',
  0x08: 'bigint',
  0x09: 'mediumint',
  0x0a: 'date',
  0x0b: 'time',
  0x0c: 'datetime',
  0x0d: 'year',
  0x0f: 'varchar',
  0x10: 'bit',
  0xf5: 'json',
  0xf6: 'decimal',
  0xf7: 'enum',
  0xf8: 'set',
  0xf9: 'tinyblob',
  0xfa: 'mediumblob',
  0xfb: 'longblob',
  0xfc: 'blob',
  0xfd: 'varchar',
  0xfe: 'char',
  0xff: 'geometry',
};
const NUMERIC_CODES = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x08, 0x09, 0x0d, 0xf6]);
const STRING_CODES = new Set([0x0f, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe]);

/** Describes a result column from the field packet, including the table column the server read it from. */
function resultField(field: FieldPacket): ResultField {
  const code = field.columnType ?? field.type ?? 0xfd;
  const binaryString = STRING_CODES.has(code) && field.characterSet === BINARY_CHARSET;
  let type = TYPE_NAMES[code] ?? 'unknown';
  if (STRING_CODES.has(code) && code >= 0xf9 && code <= 0xfc && !binaryString) type = type.replace('blob', 'text');
  if (binaryString && (code === 0xfd || code === 0x0f)) type = 'varbinary';
  if (binaryString && code === 0xfe) type = 'binary';
  const database = field.schema ?? field.db ?? '';
  return {
    name: field.name,
    type,
    numeric: NUMERIC_CODES.has(code),
    binary: binaryString || code === 0x10 || code === 0xff,
    source: field.orgTable && database ? { database, table: field.orgTable, column: field.orgName } : null,
  };
}

export class MysqlSession implements SqlSession {
  readonly kind = 'sql';
  private ended = false;
  private closing = false;
  private transaction = false;
  private readonly listeners: ((error?: Error) => void)[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly tunnel: SshTunnel | undefined,
    readonly serverVersion: ServerVersion,
    private readonly timeoutMs: number,
  ) {
    connection.on('error', (error: Error) => this.end(error));
    connection.on('end', () => this.end(this.closing ? undefined : new Error('The server closed the connection.')));
    tunnel?.onDidClose((error) => this.end(error ?? new Error('The SSH tunnel was closed.')));
  }

  get dialect(): SqlDialect {
    return this.serverVersion.product === 'MariaDB' ? 'mariadb' : 'mysql';
  }

  get connectionId(): number {
    return this.connection.threadId;
  }

  get inTransaction(): boolean {
    return this.transaction;
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows('SHOW DATABASES');
    return rows.map((r) => String(r.Database)).sort(byName);
  }

  async listObjects(database: string): Promise<DatabaseObjects> {
    const tables = await this.rows(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_count
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [database],
    );
    const routines = await this.rows(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type
         FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?`,
      [database],
    );
    const isView = (type: unknown) => type === 'VIEW' || type === 'SYSTEM VIEW';
    const names = (rows: RowDataPacket[]) => rows.map((r) => String(r.name)).sort(byName);
    return {
      tables: tables
        .filter((r) => !isView(r.type))
        .map((r) => ({ name: String(r.name), rows: r.row_count == null ? null : Number(r.row_count) }))
        .sort((a, b) => byName(a.name, b.name)),
      views: names(tables.filter((r) => isView(r.type))),
      procedures: names(routines.filter((r) => r.type === 'PROCEDURE')),
      functions: names(routines.filter((r) => r.type === 'FUNCTION')),
    };
  }

  async searchObjects(text: string, limit: number): Promise<ObjectMatch[]> {
    // `!` escapes LIKE wildcards; a backslash would depend on NO_BACKSLASH_ESCAPES. System schemas come last,
    // so the limit keeps the user's own objects.
    const pattern = `%${text.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;
    const rows = await this.rows(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS row_count
         FROM information_schema.TABLES WHERE LOWER(TABLE_NAME) LIKE ? ESCAPE '!'
       UNION ALL
       SELECT ROUTINE_SCHEMA, ROUTINE_NAME, ROUTINE_TYPE, NULL
         FROM information_schema.ROUTINES WHERE LOWER(ROUTINE_NAME) LIKE ? ESCAPE '!'
       ORDER BY db IN ('information_schema', 'performance_schema', 'mysql', 'sys'), db, name
       LIMIT ?`,
      [pattern, pattern, limit],
    );
    const kind = (type: string): ObjectKind =>
      type === 'VIEW' || type === 'SYSTEM VIEW' ? 'view' : type === 'PROCEDURE' ? 'procedure' : type === 'FUNCTION' ? 'function' : 'table';
    return rows
      .map((r) => ({
        database: String(r.db),
        kind: kind(String(r.type)),
        name: String(r.name),
        rows: r.row_count == null ? null : Number(r.row_count),
      }))
      .sort((a, b) => byName(a.database, b.database) || byName(a.name, b.name));
  }

  async describeTable(database: string, table: string): Promise<TableStructure> {
    const [info] = await this.rows(
      `SELECT TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation, AUTO_INCREMENT AS auto_increment, TABLE_COMMENT AS comment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [database, table],
    );
    if (!info) throw new Error(`Table “${database}.${table}” does not exist.`);
    const isView = text(info.type).includes('VIEW');
    const product = this.serverVersion.product === 'MariaDB' ? 'MariaDB' : 'MySQL';
    const columns: ColumnInfo[] = (
      await this.rows(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, DATA_TYPE AS data_type, IS_NULLABLE AS nullable,
                COLUMN_DEFAULT AS default_value, COLUMN_KEY AS column_key, EXTRA AS extra, COLUMN_COMMENT AS comment,
                CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, GENERATION_EXPRESSION AS generation
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [database, table],
      )
    ).map((r) => {
      const dataType = text(r.data_type).toLowerCase();
      const columnType = text(r.column_type);
      const extra = text(r.extra);
      let defaultValue = r.default_value == null ? null : text(r.default_value);
      // MariaDB writes a NULL default as the text NULL.
      if (product === 'MariaDB' && defaultValue === 'NULL') defaultValue = null;
      const nullable = text(r.nullable) === 'YES';
      const numeric = isNumericType(dataType);
      const generated = /\b(VIRTUAL|STORED|PERSISTENT)\b/i.test(extra);
      const expression = r.generation == null ? '' : text(r.generation);
      return {
        name: text(r.name),
        columnType,
        dataType,
        nullable,
        defaultValue,
        key: text(r.column_key),
        extra,
        autoIncrement: /auto_increment/i.test(extra),
        generated,
        numeric,
        binary: isBinaryType(dataType),
        enumValues: parseEnumValues(columnType),
        defaultSql: generated ? null : defaultSql(r.default_value == null ? null : text(r.default_value), { nullable, numeric, extra }, product),
        comment: text(r.comment),
        charset: r.charset == null ? null : text(r.charset),
        collation: r.collation == null ? null : text(r.collation),
        onUpdate: /on update (\S+)/i.exec(extra)?.[1] ?? null,
        generation: generated && expression ? { expression, stored: /\b(STORED|PERSISTENT)\b/i.test(extra) } : null,
        check: null as string | null,
      };
    });

    const checks: CheckInfo[] = [];
    for (const r of await this.checkRows(database, table, product)) {
      const column = columns.find((c) => c.name === text(r.name));
      // MariaDB lists a CHECK written on a column under the column's name; it belongs to the column.
      if (product === 'MariaDB' && text(r.level) === 'Column' && column) column.check = text(r.clause);
      else checks.push({ name: text(r.name), clause: text(r.clause) });
    }

    const indexes = new Map<string, IndexInfo>();
    for (const r of await this.rows(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS column_name, SUB_PART AS sub_part, INDEX_TYPE AS index_type
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
      [database, table],
    )) {
      const name = text(r.name);
      const unique = Number(r.non_unique) === 0;
      const type = text(r.index_type).toUpperCase();
      const kind = name === 'PRIMARY' ? 'PRIMARY' : type === 'FULLTEXT' || type === 'SPATIAL' ? type : unique ? 'UNIQUE' : 'INDEX';
      const index = indexes.get(name) ?? { name, kind, unique, columns: [], lengths: [] };
      index.columns.push(text(r.column_name));
      index.lengths.push(r.sub_part == null ? null : Number(r.sub_part));
      indexes.set(name, index);
    }
    const notNull = (name: string) => columns.find((c) => c.name === name)?.nullable === false;
    const key =
      indexes.get('PRIMARY') ?? [...indexes.values()].find((i) => i.unique && i.columns.length > 0 && i.columns.every(notNull));

    const foreignKeys = new Map<string, ForeignKeyInfo>();
    for (const r of await this.rows(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_SCHEMA AS ref_database,
              k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column,
              c.UPDATE_RULE AS on_update, c.DELETE_RULE AS on_delete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS c
           ON c.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND c.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [database, table],
    )) {
      const name = text(r.name);
      const fk = foreignKeys.get(name) ?? {
        name,
        columns: [],
        refDatabase: text(r.ref_database),
        refTable: text(r.ref_table),
        refColumns: [],
        onUpdate: text(r.on_update) as ReferentialAction,
        onDelete: text(r.on_delete) as ReferentialAction,
      };
      fk.columns.push(text(r.column_name));
      fk.refColumns.push(text(r.ref_column));
      foreignKeys.set(name, fk);
    }

    const collation = info.collation == null ? '' : text(info.collation);
    return {
      dialect: product === 'MariaDB' ? 'mariadb' : 'mysql',
      database,
      table,
      kind: isView ? 'view' : 'table',
      options: isView
        ? null
        : {
            comment: text(info.comment),
            engine: text(info.engine),
            // Collation names start with their character set: utf8mb4_0900_ai_ci, latin1_swedish_ci, binary.
            charset: collation.split('_')[0] ?? '',
            collation,
            autoIncrement: info.auto_increment == null ? null : Number(info.auto_increment),
          },
      checks,
      columns,
      indexes: [...indexes.values()],
      foreignKeys: [...foreignKeys.values()],
      rowKey: key ? [...key.columns] : [],
    };
  }

  /** CHECK constraints of a table; servers older than MySQL 8.0.16 have none to report. */
  private async checkRows(database: string, table: string, product: 'MySQL' | 'MariaDB'): Promise<RowDataPacket[]> {
    try {
      if (product === 'MariaDB') {
        return await this.rows(
          `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause, LEVEL AS level
             FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? ORDER BY CONSTRAINT_NAME`,
          [database, table],
        );
      }
      return await this.rows(
        `SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
           FROM information_schema.TABLE_CONSTRAINTS tc
           JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY cc.CONSTRAINT_NAME`,
        [database, table],
      );
    } catch {
      return [];
    }
  }

  async tableOptionChoices(): Promise<TableOptionChoices> {
    const engines = await this.rows(
      "SELECT ENGINE AS name FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT') AND ENGINE <> 'PERFORMANCE_SCHEMA' ORDER BY ENGINE",
    );
    const charsets = await this.rows(
      'SELECT CHARACTER_SET_NAME AS name, DEFAULT_COLLATE_NAME AS collation FROM information_schema.CHARACTER_SETS ORDER BY CHARACTER_SET_NAME',
    );
    // MariaDB lists its UCA 14 collations without a character set in COLLATIONS; the full names are here.
    const nameColumn = this.serverVersion.product === 'MariaDB' ? 'FULL_COLLATION_NAME' : 'COLLATION_NAME';
    const collations = await this.rows(
      `SELECT ${nameColumn} AS name, CHARACTER_SET_NAME AS charset FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY ORDER BY 1`,
    );
    return {
      engines: engines.map((r) => text(r.name)),
      charsets: charsets.map((r) => ({ name: text(r.name), defaultCollation: text(r.collation) })),
      collations: collations.map((r) => ({ name: text(r.name), charset: text(r.charset) })),
    };
  }

  async showCreate(database: string, name: string, kind: TableStructure['kind']): Promise<string> {
    const target = `${quoteIdentifier(database, 'mysql')}.${quoteIdentifier(name, 'mysql')}`;
    const result = await this.execute(`SHOW CREATE ${kind === 'view' ? 'VIEW' : 'TABLE'} ${target}`);
    return result.kind === 'rows' ? text(result.rows[0]?.[1]) : '';
  }

  async execute(sql: string): Promise<StatementResult> {
    const started = performance.now();
    const [result, fields] = (await this.connection.query({ sql, rowsAsArray: true, timeout: this.timeoutMs || undefined })) as [
      unknown,
      FieldPacket[] | (FieldPacket[] | undefined)[] | undefined,
    ];
    const durationMs = performance.now() - started;
    if (!Array.isArray(result)) {
      const header = result as ResultSetHeader;
      this.transaction = (header.serverStatus & SERVER_STATUS_IN_TRANS) !== 0;
      return { kind: 'ok', affectedRows: header.affectedRows, durationMs };
    }
    // CALL returns several result sets followed by an OK packet; the last result set is shown.
    if (fields && Array.isArray(fields[0])) {
      const sets = (fields as (FieldPacket[] | undefined)[]).map((f, i) => [f, (result as unknown[])[i]] as const).filter(([f]) => f);
      const [lastFields, lastRows] = sets.at(-1) ?? [[], []];
      const header = (result as unknown[]).at(-1) as ResultSetHeader | undefined;
      if (header && !Array.isArray(header)) this.transaction = (header.serverStatus & SERVER_STATUS_IN_TRANS) !== 0;
      return { kind: 'rows', fields: (lastFields ?? []).map(resultField), rows: lastRows as unknown[][], durationMs };
    }
    return { kind: 'rows', fields: ((fields ?? []) as FieldPacket[]).map(resultField), rows: result as unknown[][], durationMs };
  }

  async write(statements: readonly SqlStatement[], commit: boolean): Promise<number[]> {
    const startedHere = !this.transaction;
    if (startedHere) {
      await this.connection.query('START TRANSACTION');
      this.transaction = true;
    }
    // A savepoint lets a failed write inside an open transaction undo only itself.
    await this.connection.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const affected: number[] = [];
      for (const statement of statements) {
        const [result] = await this.connection.query<ResultSetHeader>({
          sql: statement.sql,
          values: statement.params,
          timeout: this.timeoutMs || undefined,
        });
        if (statement.expectedRows !== undefined && result.affectedRows !== statement.expectedRows) {
          throw new Error(
            `A row was changed or deleted by someone else since it was loaded (${result.affectedRows} of ${statement.expectedRows} rows matched). Nothing was written.`,
          );
        }
        affected.push(result.affectedRows);
      }
      if (commit) await this.commit();
      else await this.connection.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return affected;
    } catch (error) {
      if (startedHere) await this.rollback().catch(() => undefined);
      else await this.connection.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).catch(() => undefined);
      throw error;
    }
  }

  async streamRows(
    sql: string,
    onFields: (fields: ResultField[]) => Promise<void> | void,
    onRow: (row: unknown[]) => Promise<void> | void,
  ): Promise<number> {
    // The promise API has no streaming; the connection underneath it does.
    const core = (this.connection as unknown as { connection: CoreConnection }).connection;
    const query = core.query({ sql, rowsAsArray: true });
    let fields: FieldPacket[] = [];
    query.on('fields', (f: FieldPacket[]) => (fields = f));
    let count = 0;
    for await (const row of query.stream({ highWaterMark: 200 })) {
      if (count === 0) await onFields(fields.map(resultField));
      await onRow(row as unknown[]);
      count++;
    }
    if (count === 0) await onFields(fields.map(resultField));
    return count;
  }

  async begin(): Promise<void> {
    await this.connection.query('START TRANSACTION');
    this.transaction = true;
  }

  async commit(): Promise<void> {
    await this.connection.query('COMMIT');
    this.transaction = false;
  }

  async rollback(): Promise<void> {
    await this.connection.query('ROLLBACK');
    this.transaction = false;
  }

  async stopQuery(connectionId: number): Promise<void> {
    await this.connection.query('KILL QUERY ?', [connectionId]);
  }

  format(statement: SqlStatement): string {
    return mysql.format(statement.sql, statement.params as Parameters<typeof mysql.format>[1]);
  }

  async close(): Promise<void> {
    if (this.ended) return;
    this.closing = true;
    try {
      await this.connection.end();
    } catch {
      this.connection.destroy();
    }
    this.end();
  }

  onDidClose(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }

  private async rows(sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
    const [rows] = await this.connection.query<RowDataPacket[]>({ sql, values, timeout: this.timeoutMs || undefined });
    return rows;
  }

  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.transaction = false;
    this.connection.destroy();
    this.tunnel?.close();
    for (const listener of this.listeners) listener(error);
  }
}
