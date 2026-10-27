import {
  buildSelect,
  formatServerVersion,
  hasTransactionalDdl,
  readPanelRef,
  tableNamespace,
  type TableDataHostMessage,
  type TableDataWebviewMessage,
  type TableStructure,
} from '@datakit/core';
import * as vscode from 'vscode';
import { errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import { QueryConsolePanel } from './queryConsolePanel';
import { plural, seconds, SqlViewPanel } from './sqlViewPanel';

/** A table or view; `schema` is set for PostgreSQL, whose tables are in schemas inside the database. */
export interface TableRef {
  dataSourceId: string;
  database: string;
  schema?: string;
  table: string;
}

const EDITOR_HEIGHT_KEY = 'datakit.dataView.editorHeight';

/** The data view of a table: a SQL script whose last query fills the grid, the Structure tab, edits and exports. */
export class TableDataPanel extends SqlViewPanel {
  static readonly viewType = 'datakit.tableData';
  private static readonly panels = new Map<string, TableDataPanel>();
  private static readonly loaded = new vscode.EventEmitter<TableRef>();
  /** Fires when a data view has shown its first page; lets the tests check the whole path. */
  static readonly onDidLoad = TableDataPanel.loaded.event;
  private static readonly sent = new vscode.EventEmitter<{ ref: TableRef; message: TableDataHostMessage }>();
  /** Every message sent to a data view's page; the tests read results from it. */
  static readonly onDidPost = TableDataPanel.sent.event;

  static show(services: Services, ref: TableRef): void {
    const existing = TableDataPanel.panels.get(TableDataPanel.key(ref));
    if (existing) existing.panel.reveal();
    else new TableDataPanel(services, ref);
  }

  /**
   * Builds the data view again on a tab VS Code restores after a reload of the window. False when the data source is
   * gone or the table already has a view open; a table that is gone closes the tab once the view looks for it.
   */
  static restore(services: Services, panel: vscode.WebviewPanel, state: unknown): boolean {
    const ref = readPanelRef.tableData(state);
    const dataSource = ref && services.store.get(ref.dataSourceId);
    if (!ref || (dataSource?.engine !== 'mysql' && dataSource?.engine !== 'postgres') || TableDataPanel.panels.has(TableDataPanel.key(ref))) return false;
    new TableDataPanel(services, ref, panel);
    return true;
  }

  /** Hands a message to a data view as if its page had sent it; used by the tests. */
  static async receive(ref: TableRef, message: TableDataWebviewMessage): Promise<void> {
    await TableDataPanel.panels.get(TableDataPanel.key(ref))?.handle(message);
  }

  private static key(ref: TableRef): string {
    return `${ref.dataSourceId}\n${ref.database}\n${ref.schema ?? ''}\n${ref.table}`;
  }

  private structure: TableStructure | undefined;

  private constructor(
    services: Services,
    private readonly ref: TableRef,
    restored?: vscode.WebviewPanel,
  ) {
    super(services, ref.dataSourceId, 'tableData', `${ref.table} · ${services.store.get(ref.dataSourceId)?.name ?? ''}`, 'table.svg', ref, restored);
    TableDataPanel.panels.set(TableDataPanel.key(ref), this);
  }

  /** What qualifies the table in SQL: its database on MySQL, its schema on PostgreSQL. */
  private get namespace(): string {
    return tableNamespace(this.ref);
  }

  protected override disposed(): void {
    TableDataPanel.panels.delete(TableDataPanel.key(this.ref));
  }

  /** A PostgreSQL view connects to the table's database. */
  protected override sessionDatabase(): string | undefined {
    return this.ref.schema === undefined ? undefined : this.ref.database;
  }

  protected posted(message: TableDataHostMessage): void {
    TableDataPanel.sent.fire({ ref: this.ref, message });
  }

  protected firstPage(): void {
    TableDataPanel.loaded.fire(this.ref);
  }

  protected statusDetail(): string | null {
    return this.structure ? [this.ref.database, this.ref.schema, this.ref.table].filter((p) => p !== undefined).join('.') : null;
  }

  protected exportName(): string {
    return this.ref.table;
  }

  protected currentDatabase(): string | null {
    return this.ref.database;
  }

  protected async init(): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) {
      this.post({ type: 'initFailed', message: 'The data source no longer exists.' });
      return;
    }
    try {
      const session = await this.connect();
      this.structure = await this.describe(this.namespace, this.ref.table);
      this.autoCommit = dataSource.options.autoCommit;
      const objects = await session.listObjects(this.namespace);
      const sort = this.structure.rowKey.map((column) => ({ column, direction: 'asc' as const }));
      const pageSize = this.pageSize(dataSource);
      this.post({
        type: 'init',
        init: {
          dataSourceName: dataSource.name,
          environment: dataSource.environment,
          serverLabel: formatServerVersion(session.serverVersion),
          product: session.serverVersion.product,
          dialect: session.dialect,
          readOnly: dataSource.options.readOnly,
          structure: this.structure,
          console: null,
          pageSize,
          script: buildSelect(this.structure, { where: '', sort, limit: pageSize, offset: 0 }),
          editorHeight: this.services.context.globalState.get<number>(EDITOR_HEIGHT_KEY) ?? null,
          tables: objects.tables.map((t) => t.name),
          autoCommit: dataSource.options.autoCommit,
          ...this.exportChoice(),
        },
      });
      SqlViewPanel.updateStatusBar();
    } catch (error) {
      this.initFailed(error);
    }
  }

  protected async handleOwn(message: TableDataWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'viewDdl':
        return this.viewDdl();
      case 'editorHeight':
        await this.services.context.globalState.update(EDITOR_HEIGHT_KEY, message.height);
        return;
      case 'alterTable':
        return this.alterTable(message.statements);
      case 'openConsole':
        await QueryConsolePanel.create(this.services, this.ref.dataSourceId, this.ref.database, message.script, this.ref.schema);
        return;
    }
  }

  /**
   * Applies the Structure tab's ALTER TABLE statements, then shows the table and the current query again. On
   * PostgreSQL they run in one transaction, so they apply whole or not at all.
   */
  private async alterTable(statements: string[]): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource || !statements.length) return;
    if (dataSource.options.readOnly) {
      this.post({ type: 'alterFailed', message: 'The data source is read-only.' });
      return;
    }
    let applied = 0;
    let transactional = false;
    try {
      const session = await this.connect();
      transactional = hasTransactionalDdl(session.dialect);
      // DDL commits an open transaction behind the user's back, so it has to be finished first; on PostgreSQL the
      // change set needs a transaction of its own.
      if (session.inTransaction) {
        const reason = transactional ? 'the change set runs in a transaction of its own.' : 'ALTER TABLE would commit it.';
        this.post({ type: 'alterFailed', message: `Commit or roll back the open transaction first: ${reason}` });
        return;
      }
      const ask = { verb: 'Apply', what: `the structure changes to ${this.ref.table}` };
      if (dataSource.environment === 'production' && !(await this.confirmProduction(dataSource, statements, ask))) {
        this.post({ type: 'declined', message: 'Nothing was changed.' });
        return;
      }
      const started = performance.now();
      if (transactional) {
        await session.write(statements.map((sql) => ({ sql, params: [] })), true);
        applied = statements.length;
      } else {
        for (const statement of statements) {
          await session.execute(statement);
          applied++;
        }
      }
      this.forgetDescriptions();
      this.structure = await this.describe(this.namespace, this.ref.table);
      this.post({ type: 'structure', structure: this.structure, summary: `Table changed (${seconds(performance.now() - started)}).` });
      if (this.page) await this.query(this.page.statement);
    } catch (error) {
      // PostgreSQL's messages end without a full stop.
      const stop = /[.!?]$/.test(errorMessage(error)) ? '' : '.';
      const partly =
        transactional && !applied ? `${stop} Nothing was changed.` : applied && !transactional ? ` The first ${plural(applied, 'statement')} had been applied.` : '';
      this.forgetDescriptions();
      if (applied && this.structure) {
        this.structure = await this.describe(this.namespace, this.ref.table).catch(() => this.structure!);
        this.post({ type: 'structure', structure: this.structure, summary: '' });
      }
      this.post({ type: 'alterFailed', message: `${errorMessage(error)}${partly}` });
    }
  }

  private async viewDdl(): Promise<void> {
    if (!this.structure) return;
    try {
      const session = await this.connect();
      const ddl = await session.showCreate(this.namespace, this.ref.table, this.structure.kind);
      const document = await vscode.workspace.openTextDocument({ language: 'sql', content: `${ddl};\n` });
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not read the DDL: ${errorMessage(error)}` });
    }
  }
}
