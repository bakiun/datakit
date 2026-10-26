import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { StoredValue } from '../storedValue';
import type { DataSourceStore } from '../connections/dataSourceStore';

export const QUERY_HISTORY_VIEW = 'datakit.queryHistory';

/** A statement the user ran in a data view or a query console. */
export interface HistoryEntry {
  id: string;
  dataSourceId: string;
  database: string | null;
  sql: string;
  /** When it ran, in milliseconds since the epoch. */
  at: number;
  ok: boolean;
  /** What came of it, e.g. `3 rows (0.0012 s)`, or the error. */
  detail: string;
}

const STATE_KEY = 'datakit.queryHistory';
const MAX_ENTRIES = 1000;

/** The newest entries first, in global state. Running the same statement again moves it to the top. */
export class HistoryStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private readonly stored: StoredValue<HistoryEntry[]>;

  constructor(context: vscode.ExtensionContext) {
    this.stored = new StoredValue(context.globalState, STATE_KEY, []);
  }

  list(): HistoryEntry[] {
    return this.stored.get();
  }

  get(id: string): HistoryEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  async add(entry: Omit<HistoryEntry, 'id'>): Promise<void> {
    const sql = entry.sql.trim();
    if (!sql) return;
    const rest = this.list().filter((e) => !(e.dataSourceId === entry.dataSourceId && e.sql === sql));
    await this.update([{ ...entry, sql, id: randomUUID() }, ...rest].slice(0, MAX_ENTRIES));
  }

  async delete(id: string): Promise<void> {
    await this.update(this.list().filter((e) => e.id !== id));
  }

  /** Removes the entries of a deleted data source. */
  async deleteFor(dataSourceId: string): Promise<void> {
    await this.update(this.list().filter((e) => e.dataSourceId !== dataSourceId));
  }

  async clear(): Promise<void> {
    await this.update([]);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private async update(entries: HistoryEntry[]): Promise<void> {
    await this.stored.set(entries);
    this.changed.fire();
  }
}

const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayAndTime = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const fullTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', hour12: false });

/** `14:02` for today, `Oct 23, 14:02` before. */
export function describeTime(at: number, now = Date.now()): string {
  return new Date(at).toDateString() === new Date(now).toDateString() ? time.format(at) : dayAndTime.format(at);
}

/** The Query History view under the data sources. */
export class QueryHistoryTree implements vscode.TreeDataProvider<HistoryEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly listeners: vscode.Disposable[];

  constructor(
    private readonly history: HistoryStore,
    private readonly store: DataSourceStore,
  ) {
    this.listeners = [history.onDidChange(() => this.changed.fire(undefined)), store.onDidChange(() => this.changed.fire(undefined))];
  }

  getChildren(entry?: HistoryEntry): HistoryEntry[] {
    return entry ? [] : this.history.list();
  }

  getTreeItem(entry: HistoryEntry): vscode.TreeItem {
    const oneLine = entry.sql.replace(/\s+/g, ' ');
    const item = new vscode.TreeItem(oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine, vscode.TreeItemCollapsibleState.None);
    const dataSource = this.store.get(entry.dataSourceId)?.name ?? 'deleted data source';
    item.id = entry.id;
    item.description = `${describeTime(entry.at)} · ${dataSource}`;
    item.iconPath = entry.ok
      ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    const tip = new vscode.MarkdownString();
    tip.appendCodeblock(entry.sql, 'sql');
    tip.appendText(`${dataSource}${entry.database ? ` · ${entry.database}` : ''} · ${fullTime.format(entry.at)}`);
    tip.appendMarkdown('\n\n').appendText(entry.ok ? entry.detail : `Failed: ${entry.detail}`);
    item.tooltip = tip;
    item.contextValue = 'historyEntry';
    item.command = { command: 'datakit.openHistoryEntry', title: 'Open in Query Console', arguments: [entry] };
    return item;
  }

  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.changed.dispose();
  }
}
