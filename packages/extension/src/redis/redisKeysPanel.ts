import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import {
  editProblem,
  formatCommand,
  formatReply,
  formatServerVersion,
  planEdit,
  readPanelRef,
  RedisCheckError,
  redisTextLabel,
  removesData,
  splitCommandLine,
  supportsFieldTtl,
  supportsKeepTtl,
  type DataSource,
  type RedisEdit,
  type RedisExportFormat,
  type RedisKeyDetail,
  type RedisKeysHostMessage,
  type RedisKeysWebviewMessage,
  type RedisSession,
  type RedisText,
  type RedisValuePage,
  type ScanCommand,
} from '@datakit/core';
import { stringify } from 'csv-stringify/sync';
import * as vscode from 'vscode';
import { CancelledError, errorMessage } from '../connections/prompts';
import type { Services } from '../services';
import { openWebviewPanel, renderWebviewHtml } from '../webview/webviewHtml';

/** Strings are read up to this size; longer ones are shown cut short and cannot be edited here. */
const MAX_STRING_BYTES = 1024 * 1024;
const DEFAULT_SCAN_COUNT = 500;
/** Items read per round when a whole value is exported. */
const EXPORT_PAGE = 1000;
/** globalState key: the last key list query of each data source, by id. */
const LAST_SCAN_KEY = 'datakit.redisKeys.lastScan';

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** What an edit did, for the status line. */
function describeEdit(edit: RedisEdit): string {
  switch (edit.kind) {
    case 'hashDelete':
      return `Deleted ${plural(edit.fields.length, 'field')}`;
    case 'listDelete':
      return `Deleted ${plural(edit.items.length, 'element')}`;
    case 'setDelete':
    case 'zsetDelete':
      return `Deleted ${plural(edit.members.length, 'member')}`;
    case 'streamDelete':
      return `Deleted ${plural(edit.ids.length, 'entry')}`;
    case 'deleteKeys':
      return `Deleted ${plural(edit.keys.length, 'key')}`;
    case 'createKey':
      return `Created ${edit.key}`;
    case 'renameKey':
      return `Renamed to ${edit.to}`;
    case 'expire':
      return edit.ttl === null ? 'The key no longer expires' : `The key expires in ${plural(edit.ttl, 'second')}`;
    default:
      return 'Saved';
  }
}

/** The key that is shown after an edit: the new name after a rename, nothing after the key was deleted. */
function keyAfter(edit: RedisEdit): RedisText | null {
  if (edit.kind === 'deleteKeys') return null;
  if (edit.kind === 'renameKey') return edit.to;
  return edit.key;
}

/** Rows of a value page as plain objects for exports; binary text is written as `\x..` escapes. */
function exportRows(page: RedisValuePage): Record<string, string | number | null>[] {
  const t = redisTextLabel;
  switch (page.type) {
    case 'hash':
      return page.rows.map((r) => ({ field: t(r.field), value: t(r.value), ttl: r.ttl }));
    case 'list':
      return page.rows.map((r) => ({ index: r.index, value: t(r.value) }));
    case 'set':
      return page.rows.map((r) => ({ member: t(r.member) }));
    case 'zset':
      return page.rows.map((r) => ({ member: t(r.member), score: r.score }));
    case 'stream':
      return page.rows.map((r) => ({ id: r.id, fields: JSON.stringify(Object.fromEntries(r.fields.map(([f, v]) => [t(f), t(v)]))) }));
    default:
      return [];
  }
}

/**
 * The key browser of a Redis data source: SCAN with a pattern and type, the value of the picked key with edits
 * written at once, and a CLI. It has its own session, so it can select another database than the tree.
 */
export class RedisKeysPanel {
  static readonly viewType = 'datakit.redisKeys';
  private static readonly panels = new Map<string, RedisKeysPanel>();
  /**
   * The last key list queries of this window. globalState keeps them for the next session, but right after a write
   * it can still answer with an older value for a moment.
   */
  private static rememberedScans: Record<string, ScanCommand> | undefined;
  private static readonly loaded = new vscode.EventEmitter<string>();
  /** Fires with the data source id when a key browser has started; lets the tests check the whole path. */
  static readonly onDidLoad = RedisKeysPanel.loaded.event;
  private static readonly sent = new vscode.EventEmitter<{ dataSourceId: string; message: RedisKeysHostMessage }>();
  /** Every message sent to a key browser page; the tests read results from it. */
  static readonly onDidPost = RedisKeysPanel.sent.event;
  private static statusItem: vscode.StatusBarItem | undefined;

  /** Opens the data source's key browser, on `database` when one is given. */
  static show(services: Services, dataSourceId: string, database?: number): void {
    const existing = RedisKeysPanel.panels.get(dataSourceId);
    if (!existing) {
      new RedisKeysPanel(services, dataSourceId, database);
      return;
    }
    existing.panel.reveal();
    if (database !== undefined && database !== existing.database) void existing.select(database);
  }

  /** Brings the data source's key browser to the front, on the database it shows; tells whether one is open. */
  static reveal(dataSourceId: string): boolean {
    const existing = RedisKeysPanel.panels.get(dataSourceId);
    existing?.panel.reveal();
    return existing !== undefined;
  }

  /**
   * Builds the key browser again on a tab VS Code restores after a reload of the window, on the database it showed.
   * False when the data source is gone or has a key browser open already.
   */
  static restore(services: Services, panel: vscode.WebviewPanel, state: unknown): boolean {
    const ref = readPanelRef.redisKeys(state);
    if (!ref || services.store.get(ref.dataSourceId)?.engine !== 'redis' || RedisKeysPanel.panels.has(ref.dataSourceId)) return false;
    new RedisKeysPanel(services, ref.dataSourceId, ref.database, panel);
    return true;
  }

  /** Hands a message to a key browser as if its page had sent it; used by the tests. */
  static async receive(dataSourceId: string, message: RedisKeysWebviewMessage): Promise<void> {
    await RedisKeysPanel.panels.get(dataSourceId)?.handle(message);
  }

  static closeFor(dataSourceId: string): void {
    RedisKeysPanel.panels.get(dataSourceId)?.panel.dispose();
  }

  static disposeAll(): void {
    for (const panel of [...RedisKeysPanel.panels.values()]) panel.panel.dispose();
    RedisKeysPanel.statusItem?.dispose();
    RedisKeysPanel.statusItem = undefined;
  }

  private readonly panel: vscode.WebviewPanel;
  private session: Promise<RedisSession> | undefined;
  private database: number;
  private serverLabel = '';
  private usedMemory: string | null = null;
  /** The key whose value is shown. */
  private shown: RedisKeyDetail | undefined;

  private constructor(
    private readonly services: Services,
    private readonly dataSourceId: string,
    database: number | undefined,
    restored?: vscode.WebviewPanel,
  ) {
    const extensionUri = services.context.extensionUri;
    this.database = database ?? (Number(this.dataSource()?.database) || 0);
    this.panel = openWebviewPanel(RedisKeysPanel.viewType, this.title(), extensionUri, restored);
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'redis.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'redisKeys', this.title(), { dataSourceId, database: this.database });
    this.panel.webview.onDidReceiveMessage((message: RedisKeysWebviewMessage) => void this.handle(message));
    this.panel.onDidChangeViewState(() => RedisKeysPanel.updateStatusBar());
    this.panel.onDidDispose(() => {
      RedisKeysPanel.panels.delete(dataSourceId);
      void this.session?.then((s) => s.close(), () => undefined);
      RedisKeysPanel.updateStatusBar();
    });
    RedisKeysPanel.panels.set(dataSourceId, this);
  }

  private dataSource(): DataSource | undefined {
    return this.services.store.get(this.dataSourceId);
  }

  private title(): string {
    return `${this.dataSource()?.name ?? ''} · db${this.database}`;
  }

  private post(message: RedisKeysHostMessage): void {
    void this.panel.webview.postMessage(message);
    RedisKeysPanel.sent.fire({ dataSourceId: this.dataSourceId, message });
  }

  /** The browser's own session, opened on first use and again after the connection was lost. */
  private connect(): Promise<RedisSession> {
    if (!this.session) {
      const opening = this.services.sessions.openDedicatedRedis(this.dataSourceId).then(async (session) => {
        if (session.database !== this.database) await session.select(this.database);
        return session;
      });
      this.session = opening;
      opening.then(
        (session) =>
          session.onDidClose((error) => {
            if (this.session !== opening) return;
            this.session = undefined;
            if (error) this.post({ type: 'notice', message: `The connection was lost (${error.message}). It reconnects on the next action.`, error: true });
          }),
        () => {
          if (this.session === opening) this.session = undefined;
        },
      );
    }
    return this.session;
  }

  private scanCount(): number {
    const property = this.dataSource()?.properties.find((p) => p.key.trim() === 'scanCount');
    return Number(property?.value) > 0 ? Number(property!.value) : DEFAULT_SCAN_COUNT;
  }

  private pageSize(): number {
    return this.dataSource()?.options.pageSize ?? 100;
  }

  async handle(message: RedisKeysWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        return this.init();
      case 'scan':
        return this.scan(message.match, message.keyType, message.cursor, message.count, message.append);
      case 'open':
        return this.open(message.key);
      case 'more':
        return this.more(message.key, message.start);
      case 'edit':
        return this.edit(message.edit);
      case 'select':
        return this.select(message.database);
      case 'cli':
        return this.cli(message.line);
      case 'export':
        return this.export(message.key, message.format);
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        this.post({ type: 'notice', message: 'Copied to the clipboard.' });
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
      const session = await this.connect();
      this.serverLabel = formatServerVersion(session.serverVersion);
      this.usedMemory = await session.usedMemory();
      this.post({
        type: 'init',
        init: {
          dataSourceName: dataSource.name,
          environment: dataSource.environment,
          serverLabel: this.serverLabel,
          usedMemory: this.usedMemory,
          tls: dataSource.ssl.enabled,
          readOnly: dataSource.options.readOnly,
          database: this.database,
          databases: await session.databases(),
          pageSize: this.pageSize(),
          scanCount: this.scanCount(),
          lastScan: this.lastScans()[this.dataSourceId] ?? null,
          fieldTtl: supportsFieldTtl(session.serverVersion),
          keepTtl: supportsKeepTtl(session.serverVersion),
        },
      });
      RedisKeysPanel.updateStatusBar();
      RedisKeysPanel.loaded.fire(this.dataSourceId);
    } catch (error) {
      this.post({ type: 'initFailed', message: error instanceof CancelledError ? 'Connecting was cancelled.' : errorMessage(error) });
    }
  }

  private lastScans(): Record<string, ScanCommand> {
    return RedisKeysPanel.rememberedScans ?? this.services.context.globalState.get<Record<string, ScanCommand>>(LAST_SCAN_KEY) ?? {};
  }

  private async scan(match: string, keyType: string | null, cursor: string, count: number | null, append: boolean): Promise<void> {
    if (!append) {
      RedisKeysPanel.rememberedScans = { ...this.lastScans(), [this.dataSourceId]: { cursor: '0', match, type: keyType, count } };
      void this.services.context.globalState.update(LAST_SCAN_KEY, RedisKeysPanel.rememberedScans);
    }
    try {
      const session = await this.connect();
      const result = await session.scan(cursor, { match, type: keyType, count: count ?? this.scanCount(), want: this.pageSize() });
      this.post({ type: 'keys', keys: result.keys, cursor: result.cursor, total: await session.dbSize(), append });
    } catch (error) {
      this.post({ type: 'keysFailed', message: errorMessage(error) });
    }
  }

  private async open(key: RedisText): Promise<void> {
    try {
      const session = await this.connect();
      const detail = await session.describeKey(key);
      if (!detail) {
        this.shown = undefined;
        this.post({ type: 'keyGone', key });
        return;
      }
      this.shown = detail;
      const page = await session.readValue(key, detail.type, null, this.pageSize(), MAX_STRING_BYTES);
      this.post({ type: 'key', detail, page, append: false });
    } catch (error) {
      this.post({ type: 'keyFailed', message: errorMessage(error) });
    }
  }

  private async more(key: RedisText, start: string | number | null): Promise<void> {
    const detail = this.shown;
    if (!detail) return;
    try {
      const session = await this.connect();
      const page = await session.readValue(key, detail.type, start, this.pageSize(), MAX_STRING_BYTES);
      this.post({ type: 'key', detail, page, append: true });
    } catch (error) {
      this.post({ type: 'keyFailed', message: errorMessage(error) });
    }
  }

  private async edit(edit: RedisEdit): Promise<void> {
    const dataSource = this.dataSource();
    if (!dataSource) return;
    if (dataSource.options.readOnly) {
      this.post({ type: 'writeFailed', message: 'The data source is read-only.' });
      return;
    }
    const problem = editProblem(edit);
    if (problem) {
      this.post({ type: 'writeFailed', message: problem });
      return;
    }
    const plan = planEdit(edit);
    const commands = plan.commands.map((c) => formatCommand(c));
    if (!(await this.confirm(dataSource, edit, commands))) {
      this.post({ type: 'writeFailed', message: 'Nothing was written.', reason: 'cancelled' });
      return;
    }
    try {
      const session = await this.connect();
      await session.write(plan);
      const next = keyAfter(edit);
      this.post({ type: 'written', commands, key: next, summary: describeEdit(edit) });
      if (next !== null) await this.open(next);
      else this.shown = undefined;
    } catch (error) {
      const stale = error instanceof RedisCheckError && error.check.stale;
      this.post({ type: 'writeFailed', message: errorMessage(error), ...(stale ? { reason: 'stale' as const } : {}) });
    }
  }

  /** Deletions ask first; on a production data source every write does, with the commands it sends. */
  private async confirm(dataSource: DataSource, edit: RedisEdit, commands: string[]): Promise<boolean> {
    const production = dataSource.environment === 'production';
    const removal = removesData(edit);
    if (!production && !removal) return true;
    const where = `“${dataSource.name}”${production ? ' (Production)' : ''}`;
    const from = edit.kind === 'deleteKeys' ? '' : ` from “${redisTextLabel(edit.key)}”`;
    const what = edit.kind === 'deleteKeys' && edit.keys.length === 1 ? `Delete the key “${redisTextLabel(edit.keys[0]!)}”` : describeEdit(edit).replace(/^Deleted/, 'Delete');
    const title = removal ? `${what}${from} on ${where}?` : `Write to ${where}?`;
    const action = removal ? 'Delete' : 'Write';
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail: commands.slice(0, 10).join('\n') }, action);
    return choice === action;
  }

  private async select(database: number): Promise<void> {
    try {
      const session = await this.connect();
      await session.select(database);
      this.database = database;
      this.shown = undefined;
      this.panel.title = this.title();
      this.post({ type: 'database', database, databases: await session.databases() });
      RedisKeysPanel.updateStatusBar();
    } catch (error) {
      this.post({ type: 'notice', message: `Could not switch to db${database}: ${errorMessage(error)}`, error: true });
    }
  }

  /** Runs a CLI line. Writes are refused on a read-only data source and confirmed on a production one. */
  private async cli(line: string): Promise<void> {
    const args = splitCommandLine(line);
    if (!args.length) return;
    const dataSource = this.dataSource();
    try {
      const session = await this.connect();
      const flags = (await session.commandFlags(args[0]!).catch(() => null)) ?? [];
      const wrote = flags.includes('write');
      if (wrote && dataSource?.options.readOnly) {
        this.post({ type: 'cli', line, output: `(error) The data source is read-only; ${args[0]!.toUpperCase()} writes data.`, ok: false, durationMs: 0, wrote: false });
        return;
      }
      if (wrote && dataSource?.environment === 'production') {
        const choice = await vscode.window.showWarningMessage(`Run on “${dataSource.name}” (Production)?`, { modal: true, detail: line }, 'Run');
        if (choice !== 'Run') {
          this.post({ type: 'cli', line, output: '(error) Not run.', ok: false, durationMs: 0, wrote: false });
          return;
        }
      }
      const before = session.database;
      const started = performance.now();
      const reply = await session.command(args);
      const durationMs = performance.now() - started;
      this.post({ type: 'cli', line, output: formatReply(reply), ok: reply.kind !== 'error', durationMs, wrote: wrote && reply.kind !== 'error' });
      if (session.database !== before) {
        this.database = session.database;
        this.panel.title = this.title();
        this.post({ type: 'database', database: this.database, databases: await session.databases() });
        RedisKeysPanel.updateStatusBar();
      }
    } catch (error) {
      this.post({ type: 'cli', line, output: `(error) ${errorMessage(error)}`, ok: false, durationMs: 0, wrote: false });
    }
  }

  /** Writes the whole value of a key: every page, not only the loaded one. */
  private async export(key: RedisText, format: RedisExportFormat): Promise<void> {
    const name = redisTextLabel(key).replace(/[\\/:*?"<>|]/g, '_');
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
    const file = await vscode.window.showSaveDialog({
      title: 'Export Value',
      defaultUri: vscode.Uri.file(join(folder, `${name}.${format}`)),
      filters: format === 'json' ? { JSON: ['json'] } : { CSV: ['csv'] },
    });
    if (!file) return;
    try {
      const session = await this.connect();
      const detail = await session.describeKey(key);
      if (!detail) throw new Error('The key no longer exists.');
      const rows: Record<string, string | number | null>[] = [];
      let start: string | number | null = null;
      let text: string | null = null;
      do {
        const page = await session.readValue(key, detail.type, start, EXPORT_PAGE, Number.MAX_SAFE_INTEGER);
        if (page.type === 'string') {
          text = redisTextLabel(page.value);
          break;
        }
        if (page.type === 'other') throw new Error(page.message);
        rows.push(...exportRows(page));
        start = page.next;
      } while (start !== null);
      let content: string;
      if (text !== null) content = format === 'json' ? `${JSON.stringify({ key: redisTextLabel(key), value: text }, null, 2)}\n` : stringify([['key', 'value'], [redisTextLabel(key), text]]);
      else if (format === 'json') content = `${JSON.stringify(rows, null, 2)}\n`;
      else content = stringify([Object.keys(rows[0] ?? {}), ...rows.map((r) => Object.values(r).map((v) => (v === null ? '' : String(v))))]);
      await writeFile(file.fsPath, content);
      this.post({ type: 'notice', message: `Saved ${text !== null ? 'the value' : plural(rows.length, 'row')} to ${file.path.split('/').pop()}.` });
    } catch (error) {
      this.post({ type: 'notice', message: `Export failed: ${errorMessage(error)}`, error: true });
    }
  }

  /** The status bar shows the server of the active key browser, its memory use and TLS. */
  private static updateStatusBar(): void {
    const active = [...RedisKeysPanel.panels.values()].find((p) => p.panel.active);
    const item = (RedisKeysPanel.statusItem ??= vscode.window.createStatusBarItem('datakit.redisKeys', vscode.StatusBarAlignment.Left, 50));
    const dataSource = active?.dataSource();
    if (!active || !dataSource || !active.serverLabel) {
      item.hide();
      return;
    }
    const production = dataSource.environment === 'production';
    item.name = 'Datakit Redis';
    const memory = active.usedMemory ? ` · used_memory ${active.usedMemory}` : '';
    item.text = `$(database) ${dataSource.name} · ${active.serverLabel}${memory}${dataSource.ssl.enabled ? ' · TLS' : ''}${production ? ' · Production' : ''}`;
    item.tooltip = production ? 'Production — writes need confirmation' : `${dataSource.name}: db${active.database}`;
    item.backgroundColor = production ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.show();
  }
}
