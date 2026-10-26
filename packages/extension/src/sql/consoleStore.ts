import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { StoredValue } from '../storedValue';

/** A query console of a data source. Its script is a `.sql` file in the extension's global storage. */
export interface QueryConsole {
  id: string;
  dataSourceId: string;
  /** File name shown in the tree and the tab, e.g. `console-1.sql`. */
  name: string;
  /** The database its statements run in; null for the data source's default. */
  database: string | null;
  /** PostgreSQL: the schema that comes first in the search path; null or missing for the server's default. */
  schema?: string | null;
}

const STATE_KEY = 'datakit.consoles';

const byName = (a: QueryConsole, b: QueryConsole) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Console definitions live in global state like the data sources; their scripts live in files. */
export class ConsoleStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with the data source id whose consoles changed. */
  readonly onDidChange = this.changed.event;

  private readonly stored: StoredValue<QueryConsole[]>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.stored = new StoredValue(context.globalState, STATE_KEY, []);
  }

  list(dataSourceId: string): QueryConsole[] {
    return this.all()
      .filter((c) => c.dataSourceId === dataSourceId)
      .sort(byName);
  }

  get(id: string): QueryConsole | undefined {
    return this.all().find((c) => c.id === id);
  }

  /** Adds `console-N.sql` with the first free number; `schema` is for PostgreSQL. */
  async create(dataSourceId: string, database: string | null, script: string, schema?: string): Promise<QueryConsole> {
    const names = new Set(this.list(dataSourceId).map((c) => c.name.toLowerCase()));
    let n = 1;
    while (names.has(`console-${n}.sql`)) n++;
    const created: QueryConsole = { id: randomUUID(), dataSourceId, name: `console-${n}.sql`, database, ...(schema ? { schema } : {}) };
    await this.write(created, script);
    await this.update([...this.all(), created], dataSourceId);
    return created;
  }

  async read(queryConsole: QueryConsole): Promise<string> {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(this.file(queryConsole.id)));
    } catch {
      return '';
    }
  }

  async write(queryConsole: QueryConsole, script: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.folder());
    await vscode.workspace.fs.writeFile(this.file(queryConsole.id), new TextEncoder().encode(script));
  }

  /** Renames a console; the name gets a `.sql` ending. Returns an error message when the name cannot be used. */
  async rename(id: string, name: string): Promise<string | undefined> {
    const queryConsole = this.get(id);
    if (!queryConsole) return 'The console no longer exists.';
    const error = this.nameError(queryConsole, name);
    if (error) return error;
    await this.patch(id, { name: withSqlEnding(name.trim()) });
    return undefined;
  }

  nameError(queryConsole: QueryConsole, name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return 'Name is required.';
    if (/[\\/:*?"<>|]/.test(trimmed)) return 'The name cannot contain \\ / : * ? " < > |.';
    const full = withSqlEnding(trimmed).toLowerCase();
    if (this.list(queryConsole.dataSourceId).some((c) => c.id !== queryConsole.id && c.name.toLowerCase() === full)) {
      return `Another console of this data source is named “${withSqlEnding(trimmed)}”.`;
    }
    return undefined;
  }

  async setDatabase(id: string, database: string | null): Promise<void> {
    await this.patch(id, { database });
  }

  async setSchema(id: string, schema: string | null): Promise<void> {
    await this.patch(id, { schema });
  }

  async delete(id: string): Promise<void> {
    const queryConsole = this.get(id);
    if (!queryConsole) return;
    await this.update(
      this.all().filter((c) => c.id !== id),
      queryConsole.dataSourceId,
    );
    await vscode.workspace.fs.delete(this.file(id)).then(undefined, () => undefined);
  }

  /** Removes the consoles of a deleted data source. */
  async deleteFor(dataSourceId: string): Promise<void> {
    for (const queryConsole of this.list(dataSourceId)) await this.delete(queryConsole.id);
  }

  dispose(): void {
    this.changed.dispose();
  }

  private all(): QueryConsole[] {
    return this.stored.get();
  }

  private async patch(id: string, patch: Partial<QueryConsole>): Promise<void> {
    const queryConsole = this.get(id);
    if (!queryConsole) return;
    await this.update(
      this.all().map((c) => (c.id === id ? { ...c, ...patch } : c)),
      queryConsole.dataSourceId,
    );
  }

  private async update(consoles: QueryConsole[], dataSourceId: string): Promise<void> {
    await this.stored.set(consoles);
    this.changed.fire(dataSourceId);
  }

  private folder(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'consoles');
  }

  private file(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder(), `${id}.sql`);
  }
}

function withSqlEnding(name: string): string {
  return /\.sql$/i.test(name) ? name : `${name}.sql`;
}
