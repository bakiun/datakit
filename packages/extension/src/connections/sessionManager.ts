import {
  isPostgresSession,
  needsPassword,
  type DataSource,
  type DataSourceSettings,
  type KafkaSession,
  type MongoSession,
  type RedisSession,
  type Secrets,
  type ServerSession,
  type SqlSession,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { DataSourceStore } from './dataSourceStore';
import { driverFor } from './drivers';
import { CancelledError, errorMessage, promptForSecret } from './prompts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'failed';

export function asSql(session: ServerSession): SqlSession {
  if (session.kind !== 'sql') throw new Error('This is not a SQL data source.');
  return session as SqlSession;
}

export function asRedis(session: ServerSession): RedisSession {
  if (session.kind !== 'redis') throw new Error('This is not a Redis data source.');
  return session as RedisSession;
}

export function asMongo(session: ServerSession): MongoSession {
  if (session.kind !== 'mongodb') throw new Error('This is not a MongoDB data source.');
  return session as MongoSession;
}

export function asKafka(session: ServerSession): KafkaSession {
  if (session.kind !== 'kafka') throw new Error('This is not a Kafka data source.');
  return session as KafkaSession;
}

interface Entry {
  status: ConnectionStatus;
  session?: ServerSession;
  pending?: Promise<ServerSession>;
  error?: string;
}

function update(entry: Entry, patch: Partial<Entry>): void {
  Object.assign(entry, patch);
}

/**
 * Resolves the secrets a connection needs: saved ones, then what the editor passed in,
 * then a prompt for a password that is not saved. Returns the secrets the user typed separately.
 */
export async function resolveSecrets(
  settings: DataSourceSettings,
  saved: Secrets,
  overrides: Secrets,
): Promise<{ secrets: Secrets; typed: Secrets }> {
  const secrets: Secrets = { ...saved, ...overrides };
  const typed: Secrets = {};
  if (needsPassword(settings) && secrets.password === undefined) {
    secrets.password = typed.password = await promptForSecret(settings, 'password');
  }
  if (settings.ssh.enabled && settings.ssh.auth === 'password' && secrets.sshPassword === undefined) {
    secrets.sshPassword = typed.sshPassword = await promptForSecret(settings, 'sshPassword');
  }
  return { secrets, typed };
}

/** Keeps one open session per data source and reports its status. */
export class SessionManager implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  /** PostgreSQL sessions in databases other than the one a data source connects to, by `id\ndatabase`. */
  private readonly databaseSessions = new Map<string, Promise<SqlSession>>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with the data source id whenever its connection status changes. */
  readonly onDidChangeStatus = this.changed.event;
  private readonly storeListener: vscode.Disposable;

  constructor(private readonly store: DataSourceStore) {
    this.storeListener = store.onDidChange(() => this.forgetDeleted());
  }

  status(id: string): ConnectionStatus {
    return this.entries.get(id)?.status ?? 'idle';
  }

  error(id: string): string | undefined {
    return this.entries.get(id)?.error;
  }

  session(id: string): ServerSession | undefined {
    return this.entries.get(id)?.session;
  }

  /** Returns the open session, connecting first if needed. `overrides` are secrets typed in the editor. */
  connect(id: string, overrides: Secrets = {}): Promise<ServerSession> {
    const entry = this.entry(id);
    if (entry.session) return Promise.resolve(entry.session);
    if (entry.pending) return entry.pending;

    const pending = this.open(id, overrides);
    update(entry, { pending, status: 'connecting', error: undefined });
    this.changed.fire(id);
    pending.then(
      (session) => {
        if (entry.pending !== pending) {
          void session.close(); // disconnected while connecting
          return;
        }
        update(entry, { pending: undefined, session, status: 'connected' });
        session.onDidClose((error) => {
          if (entry.session !== session) return;
          this.closeDatabaseSessions(id);
          update(entry, { session: undefined, status: error ? 'failed' : 'idle', error: error?.message });
          this.changed.fire(id);
        });
        this.changed.fire(id);
      },
      (error: unknown) => {
        if (entry.pending !== pending) return;
        const cancelled = error instanceof CancelledError;
        update(entry, { pending: undefined, status: cancelled ? 'idle' : 'failed', error: cancelled ? undefined : errorMessage(error) });
        this.changed.fire(id);
      },
    );
    return pending;
  }

  async disconnect(id: string): Promise<void> {
    this.closeDatabaseSessions(id);
    const entry = this.entries.get(id);
    if (!entry || entry.status === 'idle') return;
    const session = entry.session;
    update(entry, { session: undefined, pending: undefined, status: 'idle', error: undefined });
    this.changed.fire(id);
    await session?.close();
  }

  /** The open session of a SQL data source, connecting first if needed. */
  async connectSql(id: string): Promise<SqlSession> {
    return asSql(await this.connect(id));
  }

  /**
   * A shared session that reaches `database`. A MySQL session reaches every database; a PostgreSQL session is bound
   * to one, so another database gets a session of its own, opened on first use and closed with the data source's.
   */
  async connectSqlIn(id: string, database: string): Promise<SqlSession> {
    const main = await this.connectSql(id);
    if (!isPostgresSession(main) || main.database === database) return main;
    const key = `${id}\n${database}`;
    const existing = this.databaseSessions.get(key);
    if (existing) return existing;
    const opening = this.open(id, {}, database).then(asSql);
    this.databaseSessions.set(key, opening);
    opening.then(
      (session) => {
        // Disconnected while connecting.
        if (this.databaseSessions.get(key) !== opening) void session.close();
        session.onDidClose(() => {
          if (this.databaseSessions.get(key) === opening) this.databaseSessions.delete(key);
        });
      },
      () => {
        if (this.databaseSessions.get(key) === opening) this.databaseSessions.delete(key);
      },
    );
    return opening;
  }

  async connectRedis(id: string): Promise<RedisSession> {
    return asRedis(await this.connect(id));
  }

  /** The MongoDB driver keeps a connection pool, so the tree and the collection tabs share one session. */
  async connectMongo(id: string): Promise<MongoSession> {
    return asMongo(await this.connect(id));
  }

  /** Kafka clients are stateless between requests, so the tree and the workspace share one session. */
  async connectKafka(id: string): Promise<KafkaSession> {
    return asKafka(await this.connect(id));
  }

  async reconnect(id: string, overrides?: Secrets): Promise<ServerSession> {
    await this.disconnect(id);
    return this.connect(id, overrides);
  }

  /** Connects the data sources marked “Connect when VS Code starts”. */
  connectOnStartup(): void {
    for (const dataSource of this.store.list().filter((d) => d.options.autoConnect)) {
      this.connect(dataSource.id).catch((error: unknown) => {
        if (error instanceof CancelledError) return;
        void vscode.window.showErrorMessage(`Could not connect to “${dataSource.name}”: ${errorMessage(error)}`);
      });
    }
  }

  dispose(): void {
    this.storeListener.dispose();
    this.changed.dispose();
    for (const id of this.entries.keys()) this.closeDatabaseSessions(id);
    for (const entry of this.entries.values()) void entry.session?.close();
    this.entries.clear();
  }

  /**
   * Opens a separate session, e.g. for a data view that needs its own transaction. `database` connects a PostgreSQL
   * data source to another database than its own. The caller closes it.
   */
  async openDedicatedSql(id: string, database?: string): Promise<SqlSession> {
    return asSql(await this.open(id, {}, database));
  }

  /** Opens a separate Redis session, e.g. for a key browser, which selects its own database. The caller closes it. */
  async openDedicatedRedis(id: string): Promise<RedisSession> {
    return asRedis(await this.open(id, {}));
  }

  private async open(id: string, overrides: Secrets, database?: string): Promise<ServerSession> {
    const dataSource: DataSource | undefined = this.store.get(id);
    if (!dataSource) throw new Error('The data source no longer exists.');
    const { secrets, typed } = await resolveSecrets(dataSource, await this.store.secrets(dataSource), overrides);
    const session = await driverFor(dataSource.engine).open(database === undefined ? dataSource : { ...dataSource, database }, secrets);
    // Typed passwords are kept only once they have worked.
    for (const key of ['password', 'sshPassword'] as const) {
      if (typed[key] !== undefined) await this.store.rememberPassword(dataSource, key, typed[key]);
    }
    return session;
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id);
    if (!entry) this.entries.set(id, (entry = { status: 'idle' }));
    return entry;
  }

  private forgetDeleted(): void {
    const ids = new Set(this.store.list().map((d) => d.id));
    for (const [id, entry] of this.entries) {
      if (ids.has(id)) continue;
      this.closeDatabaseSessions(id);
      void entry.session?.close();
      this.entries.delete(id);
    }
  }

  private closeDatabaseSessions(id: string): void {
    for (const [key, session] of this.databaseSessions) {
      if (!key.startsWith(`${id}\n`)) continue;
      this.databaseSessions.delete(key);
      void session.then((s) => s.close(), () => undefined);
    }
  }
}
