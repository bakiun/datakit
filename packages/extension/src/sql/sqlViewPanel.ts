import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildChanges,
  changesData,
  describeChanges,
  leadingKeyword,
  readOnlyReason,
  type DataSource,
  type ExportFormat,
  type ExportScope,
  type LoadedPage,
  type LogLevel,
  type ResultColumn,
  type ResultField,
  type ScriptStatement,
  type SqlSession,
  type SqlStatement,
  type StatementResult,
  type TableChange,
  type TableDataHostMessage,
  type TableDataWebviewMessage,
  type TableStructure,
} from '@datakit/core';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import { renderWebviewHtml, webviewRoot } from '../webview/webviewHtml';
import { EXPORT_EXTENSIONS, EXPORT_FILTERS, openExport, writeExport } from './exports';
import { toCellValue } from './values';

/** The table a result can be written back to, and where its key columns are in the result. */
interface EditTarget {
  structure: TableStructure;
  keyIndexes: number[];
  /** Result column name → table column name. */
  columnOf: Map<string, string>;
}

interface Page {
  statement: ScriptStatement;
  fields: ResultField[];
  rows: unknown[][];
  target: EditTarget | null;
}

export type Rows = Extract<StatementResult, { kind: 'rows' }>;

export const seconds = (ms: number) => `${(ms / 1000).toFixed(4)} s`;
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** MySQL reports a stopped query as interrupted, PostgreSQL as cancelled. */
const isInterrupted = (error: unknown) => /interrupted|canceling statement due to user request/i.test(errorMessage(error));

/** The table a page's rows are written back to; the schema only on PostgreSQL. */
function editableTable(s: TableStructure): NonNullable<LoadedPage['editable']> {
  const table = { database: s.database, table: s.table, rowKey: s.rowKey };
  return s.schema === undefined ? table : { ...table, schema: s.schema };
}

/** Turns result fields into grid columns, with the table column behind each one when there is one. */
export function resultColumns(fields: ResultField[], structure?: TableStructure): ResultColumn[] {
  return fields.map((f) => {
    const column = (structure && f.source && structure.columns.find((c) => c.name === f.source!.column)) || null;
    return { name: f.name, type: column?.dataType ?? f.type, numeric: column?.numeric ?? f.numeric, binary: column?.binary ?? f.binary, column };
  });
}

/**
 * A webview where a SQL script runs and its last query fills an editable grid: the data view of a table
 * and the query console. Each view has its own session, so a transaction it opens does not mix with other work.
 */
export abstract class SqlViewPanel {
  private static readonly open = new Set<SqlViewPanel>();
  private static statusItem: vscode.StatusBarItem | undefined;

  static disposeAll(): void {
    for (const view of [...SqlViewPanel.open]) view.panel.dispose();
    SqlViewPanel.statusItem?.dispose();
    SqlViewPanel.statusItem = undefined;
  }

  /** Closes the views of a data source, e.g. when it is deleted. */
  static closeFor(dataSourceId: string): void {
    for (const view of [...SqlViewPanel.open]) if (view.dataSourceId === dataSourceId) view.panel.dispose();
  }

  protected readonly panel: vscode.WebviewPanel;
  private session: Promise<SqlSession> | undefined;
  private readonly described = new Map<string, Promise<TableStructure>>();
  protected page: Page | undefined;
  private running = false;
  protected autoCommit = true;
  private changesInTransaction = 0;
  private firstPageShown = false;

  protected constructor(
    protected readonly services: Services,
    readonly dataSourceId: string,
    view: 'tableData' | 'queryConsole',
    title: string,
    icon: string,
  ) {
    const extensionUri = services.context.extensionUri;
    this.panel = vscode.window.createWebviewPanel(`datakit.${view}`, title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot(extensionUri)],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icons', icon);
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, view, title);
    this.panel.webview.onDidReceiveMessage((message: TableDataWebviewMessage) => void this.handle(message));
    this.panel.onDidChangeViewState(() => SqlViewPanel.updateStatusBar());
    this.panel.onDidDispose(() => {
      SqlViewPanel.open.delete(this);
      void this.session?.then((s) => s.close(), () => undefined);
      this.disposed();
      SqlViewPanel.updateStatusBar();
    });
    SqlViewPanel.open.add(this);
  }

  /** Sends the first page message and anything only this kind of view understands. */
  protected abstract init(): Promise<void>;
  /** Messages only this kind of view handles. */
  protected abstract handleOwn(message: TableDataWebviewMessage): Promise<void> | void;
  /** Sees every message posted to the page; the tests listen through it. */
  protected abstract posted(message: TableDataHostMessage): void;
  /** Called once, when the first page of rows has been shown. */
  protected abstract firstPage(): void;
  /** What the status bar shows after the data source name, e.g. `shop.orders`; null hides the item. */
  protected abstract statusDetail(): string | null;
  /** File name, without extension, suggested for exports whose rows name no table. */
  protected abstract exportName(): string;
  protected disposed(): void {}
  /**
   * The database the view's sessions connect to; undefined for the data source's own. MySQL sessions reach every
   * database, so only PostgreSQL views name one.
   */
  protected sessionDatabase(): string | undefined {
    return undefined;
  }
  /** Runs on every new session before it is used, e.g. to select the console's database. */
  protected async prepare(_session: SqlSession): Promise<void> {}
  /** The database statements run in, for the query history. */
  protected abstract currentDatabase(): string | null;
  /** Runs after each statement of a script, e.g. to follow a USE statement. */
  protected async statementRan(_session: SqlSession, _statement: ScriptStatement): Promise<void> {}

  protected dataSource(): DataSource | undefined {
    return this.services.store.get(this.dataSourceId);
  }

  protected post(message: TableDataHostMessage): void {
    void this.panel.webview.postMessage(message);
    this.posted(message);
  }

  protected log(level: LogLevel, text: string): void {
    this.post({ type: 'log', level, text });
  }

  /** The view's own session, opened on first use and again after the connection was lost. */
  protected connect(): Promise<SqlSession> {
    if (!this.session) {
      const opening = this.services.sessions.openDedicatedSql(this.dataSourceId, this.sessionDatabase()).then(async (session) => {
        try {
          await this.prepare(session);
          return session;
        } catch (error) {
          await session.close();
          throw error;
        }
      });
      this.session = opening;
      opening.then(
        (session) => {
          this.log('info', `Connected to ${this.dataSource()?.name ?? 'the data source'}.`);
          // PostgreSQL's RAISE NOTICE and warnings go to the Messages tab.
          session.onNotice?.((notice) => {
            if (this.session === opening) this.log(notice.severity === 'WARNING' ? 'warning' : 'info', `${notice.severity}: ${notice.message}`);
          });
          session.onDidClose((error) => {
            if (this.session !== opening) return;
            this.session = undefined;
            if (this.changesInTransaction) {
              this.changesInTransaction = 0;
              this.post({ type: 'transaction', open: false, changes: 0 });
              this.notice('The connection was lost; the open transaction was rolled back.', 'warning');
            } else if (error) {
              this.notice(`The connection was lost (${error.message}). It reconnects on the next action.`, 'warning');
            }
          });
        },
        () => {
          if (this.session === opening) this.session = undefined;
        },
      );
    }
    return this.session;
  }

  /** Closes the view's session; the next action opens a new one, e.g. in the console's new database. */
  protected async dropSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.forgetDescriptions();
    await session?.then((s) => s.close(), () => undefined);
  }

  /** `namespace` is the table's database on MySQL, its schema on PostgreSQL. */
  protected describe(namespace: string, table: string): Promise<TableStructure> {
    const key = `${namespace}\n${table}`;
    let structure = this.described.get(key);
    if (!structure) {
      structure = this.connect().then((s) => s.describeTable(namespace, table));
      structure.catch(() => this.described.delete(key));
      this.described.set(key, structure);
    }
    return structure;
  }

  /** Forgets table descriptions, e.g. after the table was altered. */
  protected forgetDescriptions(): void {
    this.described.clear();
  }

  protected notice(message: string, level: LogLevel = 'info'): void {
    this.post({ type: 'notice', message });
    this.log(level, message);
  }

  protected initFailed(error: unknown): void {
    this.post({ type: 'initFailed', message: error instanceof CancelledError ? 'Connecting was cancelled.' : errorMessage(error) });
  }

  /** Handles a message as if the page had sent it; the tests drive the views through it. */
  async handle(message: TableDataWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.init();
      case 'run':
        return this.run(message.statements, message.autoCommit, message.record !== false);
      case 'query':
        return this.query(message.statement);
      case 'submit':
        return this.submit(message.changes, message.autoCommit, message.statement);
      case 'commit':
        return this.endTransaction(true, message.statement);
      case 'rollback':
        return this.endTransaction(false, message.statement);
      case 'stop':
        return this.stop();
      case 'export':
        return this.export(message.format, message.scope);
      case 'copySql':
        await vscode.env.clipboard.writeText(message.sql);
        this.post({ type: 'notice', message: 'Copied to the clipboard.' });
        return;
      case 'txMode':
        this.autoCommit = message.autoCommit;
        SqlViewPanel.updateStatusBar();
        return;
      default:
        return this.handleOwn(message);
    }
  }

  /** Runs a script; the last statement that returns rows fills the grid. Each statement that ran goes into the history. */
  private async run(statements: ScriptStatement[], autoCommit: boolean, record: boolean): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource || !statements.length) return;
    let session: SqlSession;
    try {
      session = await this.connect();
      const dialect = session.dialect;
      const writes = statements.filter((s) => changesData(s.text, dialect));
      if (writes.length && dataSource.environment === 'production' && !(await this.confirmProduction(dataSource, writes.map((s) => s.text)))) {
        this.post({ type: 'runFailed', message: 'Nothing was run.' });
        this.log('warning', 'Nothing was run: the production confirmation was declined.');
        return;
      }
      if (!autoCommit && writes.length && !session.inTransaction) await session.begin();
    } catch (error) {
      this.post({ type: 'runFailed', message: errorMessage(error) });
      this.log('error', errorMessage(error));
      return;
    }

    const done: string[] = [];
    let shown: { statement: ScriptStatement; result: Rows } | undefined;
    this.running = true;
    try {
      for (const [i, statement] of statements.entries()) {
        const where = statements.length > 1 ? `Statement ${i + 1} of ${statements.length}` : 'Statement';
        let result: StatementResult;
        try {
          result = await session.execute(statement.text);
        } catch (error) {
          const message = isInterrupted(error) ? 'Query stopped.' : `${statements.length > 1 ? `${where} failed: ` : ''}${errorMessage(error)}`;
          this.post({
            type: 'runFailed',
            message,
            failed: { from: statement.from, to: statement.to },
            ...(done.length ? { summary: `Ran before it: ${done.join(' · ')}` } : {}),
          });
          this.log('error', `${where}: ${isInterrupted(error) ? 'stopped' : errorMessage(error)}`);
          if (record) this.record(statement.text, false, isInterrupted(error) ? 'Stopped.' : errorMessage(error));
          return;
        }
        const keyword = leadingKeyword(statement.text);
        // A write can return rows too, e.g. PostgreSQL's INSERT … RETURNING.
        if (changesData(statement.text, session.dialect) && session.inTransaction) this.changesInTransaction++;
        if (result.kind === 'rows') {
          shown = { statement, result };
          done.push(`${keyword} ${plural(result.rows.length, 'row')}`);
        } else {
          done.push(`${keyword} ${plural(result.affectedRows, 'row')} affected (${seconds(result.durationMs)})`);
        }
        const detail = `${done.at(-1)!.replace(/^\S+ /, '')}${result.kind === 'rows' ? ` (${seconds(result.durationMs)})` : ''}`;
        this.log('ok', `${where}: ${keyword} ${detail}`);
        if (record) this.record(statement.text, true, detail);
        await this.statementRan(session, statement);
      }
    } finally {
      this.running = false;
      this.postTransaction(session);
    }
    // The status line describes the shown query; the summary covers the rest of a longer run.
    const summary = statements.length > 1 || !shown ? `${plural(statements.length, 'statement')}: ${done.join(' · ')}` : undefined;
    if (shown) await this.show(session, shown.statement, shown.result, summary);
    else this.post({ type: 'ran', summary: summary ?? 'Done.' });
  }

  private record(sql: string, ok: boolean, detail: string): void {
    const entry = { dataSourceId: this.dataSourceId, database: this.currentDatabase(), sql, at: Date.now(), ok, detail };
    void this.services.history.add(entry);
  }

  /** Runs one query again, e.g. after the grid changed its ORDER BY or LIMIT. */
  protected async query(statement: ScriptStatement, summary?: string): Promise<void> {
    this.running = true;
    try {
      const session = await this.connect();
      const result = await session.execute(statement.text);
      this.running = false;
      if (result.kind !== 'rows') this.post({ type: 'ran', summary: `${plural(result.affectedRows, 'row')} affected` });
      else await this.show(session, statement, result, summary);
    } catch (error) {
      this.post({ type: 'runFailed', message: isInterrupted(error) ? 'Query stopped.' : errorMessage(error) });
    } finally {
      this.running = false;
    }
  }

  private async show(session: SqlSession, statement: ScriptStatement, result: Rows, summary?: string): Promise<void> {
    let total: number | null = null;
    if (statement.unpaged) {
      try {
        const count = await session.execute(`SELECT COUNT(*) FROM (${statement.unpaged}) AS datakit_count`);
        if (count.kind === 'rows') total = Number(count.rows[0]?.[0] ?? 0);
      } catch {
        // Some queries cannot be wrapped (e.g. duplicate column names); the grid pages without a total.
      }
    }
    const { target, reason, columns } = await this.editTarget(result.fields);
    this.page = { statement, fields: result.fields, rows: result.rows, target };
    this.post({
      type: 'page',
      page: {
        statement,
        columns,
        rows: result.rows.map((row) => row.map(toCellValue)),
        total,
        durationMs: result.durationMs,
        editable: target ? editableTable(target.structure) : null,
        readOnlyReason: reason,
      },
      ...(summary ? { summary } : {}),
    });
    if (!this.firstPageShown) {
      this.firstPageShown = true;
      this.firstPage();
    }
  }

  /** Works out whether the rows can be written back: they must come from one table and include its key. */
  private async editTarget(fields: ResultField[]): Promise<{ target: EditTarget | null; reason: string | null; columns: ResultColumn[] }> {
    const tables = new Map(fields.flatMap((f) => (f.source ? [[`${f.source.database}\n${f.source.schema ?? ''}\n${f.source.table}`, f.source] as const] : [])));
    let structure: TableStructure | undefined;
    if (tables.size === 1) {
      const [source] = tables.values();
      structure = await this.describe(source!.schema ?? source!.database, source!.table).catch(() => undefined);
    }
    const columns = resultColumns(fields, structure);

    const names = fields.map((f) => f.name);
    const keyIndexes = structure?.rowKey.map((key) => fields.findIndex((f) => f.source?.column === key)) ?? [];
    let reason: string | null = null;
    if (this.dataSource()?.options.readOnly) reason = 'The data source is read-only.';
    else if (tables.size === 0) reason = 'Read-only: the result does not come from a table.';
    else if (tables.size > 1) reason = 'Read-only: the result combines several tables.';
    else if (!structure) reason = 'Read-only: the table could not be described.';
    else if (readOnlyReason(structure)) reason = readOnlyReason(structure);
    else if (new Set(names).size !== names.length) reason = 'Read-only: the result has duplicate column names.';
    else if (keyIndexes.some((i) => i < 0)) {
      const missing = structure.rowKey.filter((_, i) => keyIndexes[i]! < 0);
      reason = `Read-only: add ${missing.join(', ')} to the SELECT to edit rows.`;
    }
    if (reason || !structure) return { target: null, reason, columns };
    const columnOf = new Map(fields.flatMap((f) => (f.source ? [[f.name, f.source.column] as const] : [])));
    return { target: { structure, keyIndexes, columnOf }, reason: null, columns };
  }

  private async submit(changes: TableChange[], autoCommit: boolean, statement: ScriptStatement): Promise<void> {
    const page = this.page;
    const dataSource = this.dataSource();
    const target = page?.target;
    if (!page || !dataSource) return;
    if (!target) {
      this.post({ type: 'submitFailed', message: 'These rows cannot be edited.' });
      return;
    }
    // Grid edits name result columns; the statements name table columns.
    const rename = (values: Record<string, string | null>) =>
      Object.fromEntries(Object.entries(values).flatMap(([name, value]) => (target.columnOf.has(name) ? [[target.columnOf.get(name)!, value]] : [])));
    const mapped = changes.map((c): TableChange => (c.kind === 'delete' ? c : { ...c, values: rename(c.values) }));
    const statements = buildChanges(target.structure, mapped, (row) => target.keyIndexes.map((i) => page.rows[row]?.[i]));
    try {
      const session = await this.connect();
      if (dataSource.environment === 'production' && !(await this.confirmProduction(dataSource, statements.map((s) => session.format(s)), changes))) {
        this.post({ type: 'submitFailed', message: 'Nothing was written.' });
        return;
      }
      const started = performance.now();
      await this.write(session, statements, autoCommit);
      const took = seconds(performance.now() - started);
      if (session.inTransaction) this.changesInTransaction += changes.length;
      this.postTransaction(session);
      const summary = `${describeChanges(changes)} — ${session.inTransaction ? 'not committed yet' : 'committed'} (${took})`;
      this.log('ok', summary);
      await this.query(statement, summary);
    } catch (error) {
      this.post({ type: 'submitFailed', message: errorMessage(error) });
      this.log('error', `Not written: ${errorMessage(error)}`);
    }
  }

  /** Grid edits join a transaction the script opened; otherwise the Tx mode decides. */
  private write(session: SqlSession, statements: SqlStatement[], autoCommit: boolean): Promise<number[]> {
    return session.write(statements, autoCommit && !session.inTransaction);
  }

  protected async confirmProduction(dataSource: DataSource, statements: string[], changes?: TableChange[]): Promise<boolean> {
    const preview = statements.slice(0, 10).map((s) => `${s.length > 300 ? `${s.slice(0, 300)}…` : s};`);
    if (statements.length > preview.length) preview.push(`… and ${statements.length - preview.length} more`);
    const action = changes ? 'Write' : 'Run';
    const what = changes ? describeChanges(changes) : plural(statements.length, 'statement that changes data');
    const choice = await vscode.window.showWarningMessage(
      `${action} ${what} on “${dataSource.name}” (Production)?`,
      { modal: true, detail: preview.join('\n') },
      action,
    );
    return choice === action;
  }

  private postTransaction(session: SqlSession): void {
    if (!session.inTransaction) this.changesInTransaction = 0;
    this.post({ type: 'transaction', open: session.inTransaction, changes: this.changesInTransaction });
  }

  private async endTransaction(commit: boolean, statement: ScriptStatement | null): Promise<void> {
    try {
      const session = await this.connect();
      const changes = this.changesInTransaction;
      if (commit) await session.commit();
      else await session.rollback();
      this.postTransaction(session);
      const summary = `${commit ? 'Committed' : 'Rolled back'} ${plural(changes, 'change')}`;
      this.log('info', summary);
      if (statement) await this.query(statement, summary);
      else this.post({ type: 'ran', summary });
    } catch (error) {
      this.post({ type: 'submitFailed', message: errorMessage(error) });
    }
  }

  /** Stops the running query from the data source's main session. */
  private async stop(): Promise<void> {
    if (!this.running || !this.session) return;
    try {
      const view = await this.session;
      const main = await this.services.sessions.connectSql(this.dataSourceId);
      await main.stopQuery(view.connectionId);
    } catch (error) {
      this.notice(`Could not stop the query: ${errorMessage(error)}`, 'error');
    }
  }

  private async export(format: ExportFormat, scope: ExportScope): Promise<void> {
    const page = this.page;
    if (!page) return;
    const table = page.target?.structure.table ?? page.fields.find((f) => f.source)?.source?.table ?? this.exportName();
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const file = await vscode.window.showSaveDialog({
      title: scope === 'all' ? 'Export All Rows' : 'Export Rows',
      defaultUri: vscode.Uri.file(join(folder, `${table}.${EXPORT_EXTENSIONS[format]}`)),
      filters: EXPORT_FILTERS[format],
    });
    if (!file) return;
    const name = file.path.split('/').pop();
    const generated = new Set(page.target?.structure.columns.filter((c) => c.generated).map((c) => c.name) ?? []);
    try {
      if (scope === 'page') {
        await writeExport(format, file.fsPath, { table, generated, session: await this.connect() }, page.fields.map((f) => f.name), page.rows);
        this.notice(`Saved ${plural(page.rows.length, 'row')} to ${name}.`, 'ok');
        return;
      }
      const rows = await this.exportAll(format, file.fsPath, page.statement.unlimited ?? page.statement.text, table, generated);
      if (rows !== null) this.notice(`Saved ${plural(rows, 'row')} to ${name}.`, 'ok');
    } catch (error) {
      this.notice(`Export failed: ${errorMessage(error)}`, 'error');
    }
  }

  /**
   * Streams every row of the query into the file, on a session of its own so the grid stays usable.
   * Returns the number of rows, or null when the user cancelled.
   */
  private exportAll(format: ExportFormat, file: string, sql: string, table: string, generated: Set<string>): Thenable<number | null> {
    const id = this.dataSourceId;
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${table}`, cancellable: true },
      async (progress, token) => {
        const session = await this.services.sessions.openDedicatedSql(id, this.sessionDatabase());
        let cancelled = false;
        try {
          await this.prepare(session);
          const writer = openExport(format, file, { table, generated, session });
          token.onCancellationRequested(() => {
            cancelled = true;
            void this.services.sessions
              .connectSql(id)
              .then((main) => main.stopQuery(session.connectionId))
              .catch(() => session.close());
          });
          let count = 0;
          try {
            await session.streamRows(
              sql,
              (fields) => writer.start(fields.map((f) => f.name)),
              async (row) => {
                await writer.write(row);
                if (++count % 1000 === 0) progress.report({ message: `${count.toLocaleString('en-US')} rows` });
              },
            );
            await writer.end();
            return count;
          } catch (error) {
            await writer.abort();
            if (cancelled) return null;
            throw error;
          }
        } finally {
          await session.close();
        }
      },
    );
  }

  /** The status bar shows the data source of the active view, its transaction mode and a production warning. */
  protected static updateStatusBar(): void {
    const active = [...SqlViewPanel.open].find((p) => p.panel.active);
    const item = (SqlViewPanel.statusItem ??= vscode.window.createStatusBarItem('datakit.tableData', vscode.StatusBarAlignment.Left, 50));
    const dataSource = active?.dataSource();
    const detail = active?.statusDetail();
    if (!active || !dataSource || detail === null || detail === undefined) {
      item.hide();
      return;
    }
    const production = dataSource.environment === 'production';
    item.name = 'Datakit SQL View';
    item.text = `$(database) ${dataSource.name} · Tx: ${active.autoCommit ? 'Auto' : 'Manual'}${production ? ' · Production' : ''}`;
    item.tooltip = production ? 'Production — writes need confirmation' : `${dataSource.name}${detail ? `: ${detail}` : ''}`;
    item.backgroundColor = production ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
  }
}
