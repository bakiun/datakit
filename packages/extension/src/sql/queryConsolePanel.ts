import {
  formatServerVersion,
  isPostgresSession,
  leadingKeyword,
  quoteIdentifier,
  readPanelRef,
  type ConsoleInit,
  type PostgresSession,
  type ScriptStatement,
  type SqlSession,
  type TableDataHostMessage,
  type TableDataWebviewMessage,
} from '@datakit/core';
import * as vscode from 'vscode';
import { errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import type { QueryConsole } from './consoleStore';
import { resultColumns, SqlViewPanel } from './sqlViewPanel';
import { toCellValue } from './values';

const EDITOR_HEIGHT_KEY = 'datakit.console.editorHeight';
const SAVE_DELAY_MS = 400;

/**
 * A query console: a SQL script of a data source, kept in a file, with the database to run it in.
 * Results show in the same editable grid as the data view. A PostgreSQL console is connected to its database and
 * also has a schema, which comes first in the search path.
 */
export class QueryConsolePanel extends SqlViewPanel {
  static readonly viewType = 'datakit.queryConsole';
  private static readonly panels = new Map<string, QueryConsolePanel>();
  private static readonly loaded = new vscode.EventEmitter<string>();
  /** Fires with the console id when a console page has started; lets the tests check the whole path. */
  static readonly onDidLoad = QueryConsolePanel.loaded.event;
  private static readonly sent = new vscode.EventEmitter<{ consoleId: string; message: TableDataHostMessage }>();
  /** Every message sent to a console's page; the tests read results from it. */
  static readonly onDidPost = QueryConsolePanel.sent.event;

  static show(services: Services, consoleId: string): void {
    const existing = QueryConsolePanel.panels.get(consoleId);
    if (existing) existing.panel.reveal();
    else if (services.consoles.get(consoleId)) new QueryConsolePanel(services, consoleId);
  }

  /** Adds a console to a data source and opens it; `schema` is for PostgreSQL. */
  static async create(services: Services, dataSourceId: string, database: string | null, script = '', schema?: string): Promise<QueryConsole> {
    const created = await services.consoles.create(dataSourceId, database, script, schema);
    QueryConsolePanel.show(services, created.id);
    return created;
  }

  /**
   * Builds the console again on a tab VS Code restores after a reload of the window; its script is in its file.
   * False when the console or its data source is gone, or the console is open already.
   */
  static restore(services: Services, panel: vscode.WebviewPanel, state: unknown): boolean {
    const ref = readPanelRef.queryConsole(state);
    const queryConsole = ref && services.consoles.get(ref.consoleId);
    if (!queryConsole || !services.store.get(queryConsole.dataSourceId) || QueryConsolePanel.panels.has(queryConsole.id)) return false;
    new QueryConsolePanel(services, queryConsole.id, panel);
    return true;
  }

  /** Hands a message to a console as if its page had sent it; used by the tests. */
  static async receive(consoleId: string, message: TableDataWebviewMessage): Promise<void> {
    await QueryConsolePanel.panels.get(consoleId)?.handle(message);
  }

  /** Puts the console's new name on its tab. */
  static renamed(services: Services, consoleId: string): void {
    const panel = QueryConsolePanel.panels.get(consoleId);
    const queryConsole = services.consoles.get(consoleId);
    if (panel && queryConsole) panel.panel.title = QueryConsolePanel.title(services, queryConsole);
  }

  /**
   * Puts a statement at the end of the data source's console that was used last, if one is open;
   * otherwise opens a new console with it.
   */
  static async openWith(services: Services, dataSourceId: string, database: string | null, sql: string): Promise<void> {
    const [open] = [...QueryConsolePanel.panels.values()].filter((p) => p.dataSourceId === dataSourceId).sort((a, b) => b.lastActive - a.lastActive);
    if (!open) {
      await QueryConsolePanel.create(services, dataSourceId, database, sql);
      return;
    }
    open.panel.reveal();
    open.post({ type: 'insertScript', text: sql });
  }

  static close(consoleId: string): void {
    QueryConsolePanel.panels.get(consoleId)?.panel.dispose();
  }

  private static title(services: Services, queryConsole: QueryConsole): string {
    return `${queryConsole.name} · ${services.store.get(queryConsole.dataSourceId)?.name ?? ''}`;
  }

  private database: string | null;
  /** PostgreSQL: the schema unqualified names resolve to first. */
  private schema: string | null;
  private unsaved: string | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private lastActive = Date.now();

  private constructor(
    services: Services,
    private readonly consoleId: string,
    restored?: vscode.WebviewPanel,
  ) {
    const queryConsole = services.consoles.get(consoleId)!;
    super(services, queryConsole.dataSourceId, 'queryConsole', QueryConsolePanel.title(services, queryConsole), 'console.svg', { consoleId }, restored);
    this.database = queryConsole.database;
    this.schema = queryConsole.schema ?? null;
    this.panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) this.lastActive = Date.now();
    });
    QueryConsolePanel.panels.set(consoleId, this);
  }

  private queryConsole(): QueryConsole | undefined {
    return this.services.consoles.get(this.consoleId);
  }

  private get postgres(): boolean {
    return this.dataSource()?.engine === 'postgres';
  }

  protected override disposed(): void {
    QueryConsolePanel.panels.delete(this.consoleId);
    void this.save();
  }

  protected posted(message: TableDataHostMessage): void {
    QueryConsolePanel.sent.fire({ consoleId: this.consoleId, message });
  }

  protected firstPage(): void {}

  protected statusDetail(): string | null {
    const queryConsole = this.queryConsole();
    if (!queryConsole) return null;
    if (!this.database) return queryConsole.name;
    return `${queryConsole.name} · ${this.database}${this.schema ? `.${this.schema}` : ''}`;
  }

  protected exportName(): string {
    return 'result';
  }

  protected currentDatabase(): string | null {
    return this.database;
  }

  /** MySQL without a database selected: says where to pick one. */
  protected override errorText(error: unknown): string {
    if (this.postgres || this.database || !/^No database selected\.?$/i.test(errorMessage(error))) return super.errorText(error);
    return 'No database selected. Pick one in the Source list above, or write the table as database.table.';
  }

  /** A PostgreSQL console connects to its database. */
  protected override sessionDatabase(): string | undefined {
    return this.postgres ? (this.database ?? undefined) : undefined;
  }

  /**
   * Selects the console's database (MySQL) or schema (PostgreSQL) on every new session; one that is gone is dropped
   * from the console.
   */
  protected override async prepare(session: SqlSession): Promise<void> {
    if (isPostgresSession(session)) {
      if (!this.schema) return;
      try {
        await session.setSchema(this.schema);
      } catch (error) {
        this.notice(`Could not use schema ${this.schema}: ${errorMessage(error)}`, 'warning');
        this.schema = null;
        await this.services.consoles.setSchema(this.consoleId, null);
      }
      return;
    }
    if (!this.database) return;
    try {
      await session.execute(`USE ${quoteIdentifier(this.database, session.dialect)}`);
    } catch (error) {
      this.notice(`Could not use ${this.database}: ${errorMessage(error)}`, 'warning');
      this.database = null;
      await this.services.consoles.setDatabase(this.consoleId, null);
    }
  }

  /** A USE statement (MySQL) or a new search path (PostgreSQL) in the script switches the selector too. */
  protected override async statementRan(session: SqlSession, statement: ScriptStatement): Promise<void> {
    const keyword = leadingKeyword(statement.text);
    if (isPostgresSession(session)) {
      if ((keyword !== 'SET' && keyword !== 'RESET') || !/search_path|\bALL\b/i.test(statement.text)) return;
      const schema = await session.currentSchema();
      if (schema !== this.schema) await this.schemaSwitched(session, schema);
      return;
    }
    if (keyword !== 'USE') return;
    const current = await this.databaseOf(session);
    if (current !== this.database) await this.switched(session, current);
  }

  protected async init(): Promise<void> {
    const dataSource = this.dataSource();
    const queryConsole = this.queryConsole();
    if (!dataSource || !queryConsole) {
      this.post({ type: 'initFailed', message: dataSource ? 'The console no longer exists.' : 'The data source no longer exists.' });
      return;
    }
    try {
      const session = await this.connectToConsoleDatabase();
      this.autoCommit = dataSource.options.autoCommit;
      let consoleInit: ConsoleInit;
      if (isPostgresSession(session)) {
        this.database = session.database;
        this.schema = await session.currentSchema();
        consoleInit = { name: queryConsole.name, database: this.database, databases: await session.listDatabases(), schema: this.schema, schemas: await session.listSchemas() };
      } else {
        // Without a database of its own, the console starts in the data source's default one.
        this.database = await this.databaseOf(session);
        consoleInit = { name: queryConsole.name, database: this.database, databases: await session.listDatabases() };
      }
      this.post({
        type: 'init',
        init: {
          dataSourceName: dataSource.name,
          environment: dataSource.environment,
          serverLabel: formatServerVersion(session.serverVersion),
          product: session.serverVersion.product,
          dialect: session.dialect,
          readOnly: dataSource.options.readOnly,
          structure: null,
          console: consoleInit,
          pageSize: this.pageSize(dataSource),
          script: this.unsaved ?? (await this.services.consoles.read(queryConsole)),
          editorHeight: this.services.context.globalState.get<number>(EDITOR_HEIGHT_KEY) ?? null,
          tables: await this.tables(session),
          autoCommit: dataSource.options.autoCommit,
          ...this.exportChoice(),
        },
      });
      SqlViewPanel.updateStatusBar();
      QueryConsolePanel.loaded.fire(this.consoleId);
    } catch (error) {
      this.initFailed(error);
    }
  }

  /** A PostgreSQL console whose database is gone falls back to the data source's own, as a MySQL console does. */
  private async connectToConsoleDatabase(): Promise<SqlSession> {
    try {
      return await this.connect();
    } catch (error) {
      if (!this.postgres || !this.database || !/database ".*" does not exist/.test(errorMessage(error))) throw error;
      this.notice(`Could not use ${this.database}: ${errorMessage(error)}`, 'warning');
      this.database = null;
      this.schema = null;
      await this.services.consoles.setDatabase(this.consoleId, null);
      await this.services.consoles.setSchema(this.consoleId, null);
      return this.connect();
    }
  }

  protected async handleOwn(message: TableDataWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'script':
        this.unsaved = message.script;
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY_MS);
        return;
      case 'useDatabase':
        return this.postgres ? this.reconnectTo(message.database) : this.useDatabase(message.database);
      case 'useSchema':
        return this.useSchema(message.schema);
      case 'explain':
        return this.explain(message.statement, message.analyze === true);
      case 'editorHeight':
        await this.services.context.globalState.update(EDITOR_HEIGHT_KEY, message.height);
        return;
    }
  }

  /** Writes the script the page sent last; also called when the tab closes. */
  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    const script = this.unsaved;
    const queryConsole = this.queryConsole();
    if (script === undefined || !queryConsole) return;
    this.unsaved = undefined;
    try {
      await this.services.consoles.write(queryConsole, script);
    } catch (error) {
      this.unsaved ??= script;
      void vscode.window.showErrorMessage(`Could not save ${queryConsole.name}: ${errorMessage(error)}`);
    }
  }

  private async useDatabase(database: string): Promise<void> {
    let session: SqlSession | undefined;
    try {
      session = await this.connect();
      await session.execute(`USE ${quoteIdentifier(database, session.dialect)}`);
      await this.switched(session, database);
    } catch (error) {
      this.notice(`Could not use ${database}: ${errorMessage(error)}`, 'error');
      // Puts the selector back on the database the session is really in.
      if (session) this.post({ type: 'database', database: this.database ?? '', tables: await this.tables(session).catch(() => []) });
    }
  }

  /** A PostgreSQL session is bound to its database, so another one takes a new session. */
  private async reconnectTo(database: string): Promise<void> {
    const current = await this.connect().catch(() => undefined);
    if (current?.inTransaction) {
      this.notice('Commit or roll back the open transaction first: another database takes a new connection.', 'warning');
      await this.postLocation(current);
      return;
    }
    const previous = { database: this.database, schema: this.schema };
    this.database = database;
    this.schema = null;
    await this.dropSession();
    try {
      await this.switched(await this.connect(), database);
    } catch (error) {
      this.notice(`Could not use ${database}: ${errorMessage(error)}`, 'error');
      ({ database: this.database, schema: this.schema } = previous);
      await this.dropSession();
      const session = await this.connect().catch(() => undefined);
      if (session) await this.postLocation(session);
    }
  }

  private async useSchema(schema: string): Promise<void> {
    let session: PostgresSession | undefined;
    try {
      const connected = await this.connect();
      if (!isPostgresSession(connected)) return;
      session = connected;
      await session.setSchema(schema);
      await this.schemaSwitched(session, schema);
    } catch (error) {
      this.notice(`Could not use schema ${schema}: ${errorMessage(error)}`, 'error');
      if (session) await this.postLocation(session).catch(() => undefined);
    }
  }

  private async switched(session: SqlSession, database: string | null): Promise<void> {
    this.database = database;
    await this.services.consoles.setDatabase(this.consoleId, database);
    if (isPostgresSession(session)) {
      this.schema = await session.currentSchema();
      await this.services.consoles.setSchema(this.consoleId, null);
    }
    await this.postLocation(session);
    if (database) this.log('info', `Using database ${database}.`);
    SqlViewPanel.updateStatusBar();
  }

  private async schemaSwitched(session: PostgresSession, schema: string | null): Promise<void> {
    this.schema = schema;
    await this.services.consoles.setSchema(this.consoleId, schema);
    await this.postLocation(session);
    if (schema) this.log('info', `Using schema ${schema}.`);
    SqlViewPanel.updateStatusBar();
  }

  /** Tells the page where statements run: the database, on PostgreSQL also the schema, and the tables to complete. */
  private async postLocation(session: SqlSession): Promise<void> {
    const tables = await this.tables(session);
    if (isPostgresSession(session)) {
      this.post({ type: 'database', database: this.database ?? '', tables, schema: this.schema ?? '', schemas: await session.listSchemas() });
    } else {
      this.post({ type: 'database', database: this.database ?? '', tables });
    }
  }

  private async explain(statement: string, analyze: boolean): Promise<void> {
    try {
      const session = await this.connect();
      const result = isPostgresSession(session) ? await session.explain(statement, analyze) : await session.execute(`EXPLAIN ${statement}`);
      if (result.kind !== 'rows') throw new Error('The server returned no plan.');
      this.post({ type: 'plan', statement, columns: resultColumns(result.fields), rows: result.rows.map((row) => row.map(toCellValue)) });
    } catch (error) {
      this.post({ type: 'planFailed', message: errorMessage(error) });
    }
  }

  private async databaseOf(session: SqlSession): Promise<string | null> {
    if (isPostgresSession(session)) return session.database;
    const result = await session.execute('SELECT DATABASE()');
    const value = result.kind === 'rows' ? result.rows[0]?.[0] : null;
    return value === null || value === undefined ? null : String(value);
  }

  /** Tables of the console's database (MySQL) or schema (PostgreSQL), for completion. */
  private async tables(session: SqlSession): Promise<string[]> {
    const namespace = isPostgresSession(session) ? this.schema : this.database;
    return namespace ? (await session.listObjects(namespace)).tables.map((t) => t.name) : [];
  }
}
