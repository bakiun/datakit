import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  formatServerVersion,
  type DataSource,
  type MongoCollectionHostMessage,
  type MongoCollectionWebviewMessage,
  type MongoEdit,
  type MongoExportFormat,
  type MongoExportQuery,
  type MongoSession,
} from '@datakit/core';
import { stringify } from 'csv-stringify/sync';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import { renderWebviewHtml, webviewRoot } from '../webview/webviewHtml';

export interface CollectionRef {
  dataSourceId: string;
  database: string;
  collection: string;
}

/** Documents the schema analysis reads when the page does not say. */
const DEFAULT_SCHEMA_SAMPLE = 1000;
const MAX_SCHEMA_SAMPLE = 10_000;

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** One line for the confirmation a production data source asks for. */
function describeEdit(edit: MongoEdit): string {
  switch (edit.kind) {
    case 'insert':
      return 'Insert documents';
    case 'replace':
      return 'Replace a document';
    case 'setField':
      return `Set ${edit.path} = ${edit.value.slice(0, 200)}`;
    case 'unsetField':
      return `Remove the field ${edit.path}`;
    case 'delete':
      return `Delete ${plural(edit.ids.length, 'document')}`;
    case 'deleteMatching':
      return `Delete every document matching ${edit.filter.slice(0, 200)}`;
    case 'updateMatching':
      return `Update every document matching ${edit.filter.slice(0, 200)}`;
    case 'createIndex':
      return `Create an index on ${edit.spec.keys.slice(0, 200)}`;
    case 'dropIndex':
      return `Drop the index ${edit.name}`;
    case 'hideIndex':
      return `${edit.hidden ? 'Hide' : 'Unhide'} the index ${edit.name}`;
  }
}

/** A cell of a CSV export: text as is, other values as relaxed Extended JSON. */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The tab of a MongoDB collection: documents found with a filter (list, table and JSON views) and edited in place,
 * aggregations, explain, indexes, a sampled schema, exports and a shell. It uses the data source's shared session;
 * the driver keeps a connection pool, so nothing here holds state on the server.
 */
export class MongoCollectionPanel {
  private static readonly panels = new Map<string, MongoCollectionPanel>();
  private static readonly loaded = new vscode.EventEmitter<CollectionRef>();
  /** Fires when a collection tab has started; lets the tests check the whole path. */
  static readonly onDidLoad = MongoCollectionPanel.loaded.event;
  private static readonly sent = new vscode.EventEmitter<{ ref: CollectionRef; message: MongoCollectionHostMessage }>();
  /** Every message sent to a collection page; the tests read results from it. */
  static readonly onDidPost = MongoCollectionPanel.sent.event;

  static show(services: Services, ref: CollectionRef): void {
    const existing = MongoCollectionPanel.panels.get(MongoCollectionPanel.key(ref));
    if (existing) existing.panel.reveal();
    else new MongoCollectionPanel(services, ref);
  }

  /** Hands a message to a collection tab as if its page had sent it; used by the tests. */
  static async receive(ref: CollectionRef, message: MongoCollectionWebviewMessage): Promise<void> {
    await MongoCollectionPanel.panels.get(MongoCollectionPanel.key(ref))?.handle(message);
  }

  /** Closes the tabs of a data source, or of one of its databases or collections. */
  static closeFor(dataSourceId: string, database?: string, collection?: string): void {
    for (const panel of [...MongoCollectionPanel.panels.values()]) {
      const r = panel.ref;
      if (r.dataSourceId !== dataSourceId || (database !== undefined && r.database !== database)) continue;
      if (collection !== undefined && r.collection !== collection) continue;
      panel.panel.dispose();
    }
  }

  static disposeAll(): void {
    for (const panel of [...MongoCollectionPanel.panels.values()]) panel.panel.dispose();
  }

  private static key(ref: CollectionRef): string {
    return `${ref.dataSourceId}\n${ref.database}\n${ref.collection}`;
  }

  private readonly panel: vscode.WebviewPanel;
  /** The database `db` points at in the shell; `use` changes it. */
  private shellDatabase: string;

  private constructor(
    private readonly services: Services,
    private readonly ref: CollectionRef,
  ) {
    const extensionUri = services.context.extensionUri;
    this.shellDatabase = ref.database;
    const title = `${ref.collection} · ${services.store.get(ref.dataSourceId)?.name ?? ''}`;
    this.panel = vscode.window.createWebviewPanel('datakit.mongoCollection', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot(extensionUri)],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'mongodb.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'mongoCollection', title);
    this.panel.webview.onDidReceiveMessage((message: MongoCollectionWebviewMessage) => void this.handle(message));
    this.panel.onDidDispose(() => MongoCollectionPanel.panels.delete(MongoCollectionPanel.key(ref)));
    MongoCollectionPanel.panels.set(MongoCollectionPanel.key(ref), this);
  }

  private dataSource(): DataSource | undefined {
    return this.services.store.get(this.ref.dataSourceId);
  }

  private post(message: MongoCollectionHostMessage): void {
    void this.panel.webview.postMessage(message);
    MongoCollectionPanel.sent.fire({ ref: this.ref, message });
  }

  private session(): Promise<MongoSession> {
    return this.services.sessions.connectMongo(this.ref.dataSourceId);
  }

  async handle(message: MongoCollectionWebviewMessage): Promise<void> {
    const { database, collection } = this.ref;
    switch (message.type) {
      case 'ready':
        return this.init();
      case 'find':
      case 'aggregate':
        try {
          const session = await this.session();
          const started = performance.now();
          const page =
            message.type === 'find'
              ? await session.find(database, collection, message.query)
              : await session.aggregate(database, collection, message.pipeline, message.limit);
          this.post({ type: 'page', requestId: message.requestId, page, durationMs: performance.now() - started });
        } catch (error) {
          this.post({ type: 'pageFailed', requestId: message.requestId, message: errorMessage(error) });
        }
        return;
      case 'explain':
        try {
          this.post({ type: 'explain', explain: await (await this.session()).explain(database, collection, message.query) });
        } catch (error) {
          this.post({ type: 'explainFailed', message: errorMessage(error) });
        }
        return;
      case 'load':
        try {
          const session = await this.session();
          if (message.what === 'indexes') this.post({ type: 'indexes', indexes: await session.indexes(database, collection) });
          else if (message.what === 'info') return this.postInfo(session);
          else {
            const sample = Math.min(MAX_SCHEMA_SAMPLE, Math.max(1, Math.floor(message.sample ?? DEFAULT_SCHEMA_SAMPLE)));
            this.post({ type: 'schema', schema: await session.schema(database, collection, sample) });
          }
        } catch (error) {
          this.post({ type: 'loadFailed', what: message.what, message: errorMessage(error) });
        }
        return;
      case 'edit':
        return this.edit(message.edit);
      case 'shell':
        return this.shell(message.line);
      case 'export':
        return this.export(message.query, message.format);
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        this.post({ type: 'notice', message: `Copied ${message.what} to the clipboard.` });
        return;
    }
  }

  private async init(): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) {
      this.post({ type: 'initFailed', message: 'The data source no longer exists.' });
      return;
    }
    try {
      const session = await this.session();
      const info = await session.collection(this.ref.database, this.ref.collection);
      if (!info) {
        this.post({ type: 'initFailed', message: `${this.ref.database}.${this.ref.collection} no longer exists.` });
        return;
      }
      this.post({
        type: 'init',
        init: {
          dataSourceName: dataSource.name,
          environment: dataSource.environment,
          serverLabel: formatServerVersion(session.serverVersion),
          topology: session.topology,
          database: this.ref.database,
          collection: this.ref.collection,
          type: info.type,
          readOnly: dataSource.options.readOnly,
          pageSize: dataSource.options.pageSize,
          info,
        },
      });
      MongoCollectionPanel.loaded.fire(this.ref);
    } catch (error) {
      this.post({ type: 'initFailed', message: error instanceof CancelledError ? 'Connecting was cancelled.' : errorMessage(error) });
    }
  }

  private async postInfo(session: MongoSession): Promise<void> {
    const info = await session.collection(this.ref.database, this.ref.collection);
    if (info) this.post({ type: 'info', info });
    else this.post({ type: 'loadFailed', what: 'info', message: `${this.ref.database}.${this.ref.collection} no longer exists.` });
  }

  /** Asks before a write on a production data source; a read-only one refuses it. Returns why it may not run. */
  private async refusal(dataSource: DataSource, description: string): Promise<string | null> {
    if (dataSource.options.readOnly) return 'The data source is read-only.';
    if (dataSource.environment !== 'production') return null;
    const choice = await vscode.window.showWarningMessage(`Change “${dataSource.name}” (Production)?`, { modal: true, detail: description }, 'Apply');
    return choice === 'Apply' ? null : 'Nothing was changed.';
  }

  private async edit(edit: MongoEdit): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) return;
    const refused = await this.refusal(dataSource, `${this.ref.database}.${this.ref.collection}: ${describeEdit(edit)}`);
    if (refused) {
      this.post({ type: 'writeFailed', kind: edit.kind, message: refused });
      return;
    }
    try {
      const session = await this.session();
      const result = await session.write(this.ref.database, this.ref.collection, edit);
      this.post({ type: 'written', kind: edit.kind, result });
      await this.postInfo(session).catch(() => undefined);
    } catch (error) {
      this.post({ type: 'writeFailed', kind: edit.kind, message: errorMessage(error) });
    }
  }

  /** Runs a shell line. Writes are refused on a read-only data source and confirmed on a production one. */
  private async shell(line: string): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) return;
    const answer = (output: string, ok: boolean, durationMs = 0, wrote = false) =>
      this.post({ type: 'shell', line, output, ok, durationMs, database: this.shellDatabase, wrote });
    try {
      const session = await this.session();
      const plan = session.planShell(this.shellDatabase, line);
      if (plan.writes) {
        const refused = await this.refusal(dataSource, plan.description);
        if (refused) {
          answer(refused, false);
          return;
        }
      }
      const started = performance.now();
      const result = await session.shell(this.shellDatabase, line);
      this.shellDatabase = result.database;
      answer(result.output, result.ok, performance.now() - started, plan.writes && result.ok);
    } catch (error) {
      answer(errorMessage(error), false);
    }
  }

  /** Saves every matching document, not only the page, with a cancellable progress notification. */
  private async export(query: MongoExportQuery, format: MongoExportFormat): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const extension = format === 'jsonl' ? 'jsonl' : format;
    const file = await vscode.window.showSaveDialog({
      title: 'Export Documents',
      defaultUri: vscode.Uri.file(join(folder, `${this.ref.collection.replace(/[\\/:*?"<>|]/g, '_')}.${extension}`)),
      filters: format === 'csv' ? { CSV: ['csv'] } : format === 'jsonl' ? { 'JSON Lines': ['jsonl'] } : { JSON: ['json'] },
    });
    if (!file) return;
    const name = file.path.split('/').pop();
    try {
      const session = await this.session();
      const out = createWriteStream(file.fsPath);
      const write = async (text: string) => {
        if (!out.write(text)) await once(out, 'drain');
      };
      let columns: string[] | null = null;
      let first = true;
      let cancelled = false;
      let read = 0;
      if (format === 'json') await write('[\n');
      const count = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${this.ref.collection} to ${name}`, cancellable: true },
        (progress, token) =>
          session.exportDocuments(this.ref.database, this.ref.collection, query, async (documents) => {
            for (const doc of documents) {
              if (format === 'csv') {
                // Columns are the top-level fields of the first batch; later fields are left out.
                if (!columns) {
                  columns = [...new Set(documents.flatMap((d) => Object.keys(d)))];
                  await write(stringify([columns]));
                }
                await write(stringify([columns.map((c) => csvCell(doc[c]))]));
              } else if (format === 'jsonl') {
                await write(`${JSON.stringify(doc)}\n`);
              } else {
                await write(`${first ? '' : ',\n'}  ${JSON.stringify(doc)}`);
              }
              first = false;
            }
            read += documents.length;
            progress.report({ message: plural(read, 'document') });
            cancelled = token.isCancellationRequested;
            return !cancelled;
          }),
      );
      if (format === 'json') await write(`${first ? '' : '\n'}]\n`);
      out.end();
      await once(out, 'close');
      this.post({ type: 'notice', message: `${cancelled ? 'Stopped; saved' : 'Saved'} ${plural(count, 'document')} to ${name}.` });
    } catch (error) {
      this.post({ type: 'notice', message: `Export failed: ${errorMessage(error)}` });
    }
  }
}
