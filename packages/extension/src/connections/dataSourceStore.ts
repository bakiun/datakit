import { randomUUID } from 'node:crypto';
import {
  cloneSettings,
  createDataSourceSettings,
  needsPassword,
  type DataSource,
  type DataSourceSettings,
  type SecretKey,
  type SecretPatch,
  type Secrets,
} from '@datakit/core';
import * as vscode from 'vscode';
import { StoredValue } from '../storedValue';

const STATE_KEY = 'datakit.dataSources';
const SECRET_KEYS: readonly SecretKey[] = ['password', 'sshPassword', 'sshPassphrase'];

const byName = (a: DataSource, b: DataSource) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/**
 * Data source definitions live in global state, so they are available in every workspace.
 * Passwords live in SecretStorage, or in memory when they are kept only until VS Code restarts.
 */
export class DataSourceStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly sessionPasswords = new Map<string, string>();
  private readonly stored: StoredValue<DataSource[]>;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.stored = new StoredValue(context.globalState, STATE_KEY, []);
  }

  list(): DataSource[] {
    return this.stored.get().map(withDefaults).sort(byName);
  }

  get(id: string): DataSource | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** Creates a data source when `id` is null; otherwise replaces it. */
  async save(id: string | null, settings: DataSourceSettings, secrets: SecretPatch): Promise<DataSource> {
    const dataSource: DataSource = { ...cloneSettings(settings), id: id ?? randomUUID() };
    dataSource.name = dataSource.name.trim();
    const others = this.list().filter((d) => d.id !== dataSource.id);
    await this.stored.set([...others, dataSource]);
    await this.updateSecrets(dataSource, secrets);
    this.changed.fire();
    return dataSource;
  }

  async delete(id: string): Promise<void> {
    await this.stored.set(this.list().filter((d) => d.id !== id));
    this.sessionPasswords.delete(id);
    await Promise.all(SECRET_KEYS.map((key) => this.context.secrets.delete(secretId(id, key))));
    this.changed.fire();
  }

  /** The secrets available without asking the user. */
  async secrets(dataSource: DataSource): Promise<Secrets> {
    const result: Secrets = {};
    const password =
      dataSource.passwordStorage === 'session'
        ? this.sessionPasswords.get(dataSource.id)
        : await this.context.secrets.get(secretId(dataSource.id, 'password'));
    if (password !== undefined) result.password = password;
    for (const key of ['sshPassword', 'sshPassphrase'] as const) {
      const value = await this.context.secrets.get(secretId(dataSource.id, key));
      if (value !== undefined) result[key] = value;
    }
    return result;
  }

  async storedSecrets(dataSource: DataSource): Promise<Record<SecretKey, boolean>> {
    const secrets = await this.secrets(dataSource);
    return { password: 'password' in secrets, sshPassword: 'sshPassword' in secrets, sshPassphrase: 'sshPassphrase' in secrets };
  }

  /** Keeps a password the user typed when connecting, as far as the data source's “Save” choice allows. */
  async rememberPassword(dataSource: DataSource, key: SecretKey, value: string): Promise<void> {
    if (key === 'password') {
      if (dataSource.passwordStorage === 'session') this.sessionPasswords.set(dataSource.id, value);
      else if (dataSource.passwordStorage === 'forever') await this.context.secrets.store(secretId(dataSource.id, key), value);
    } else {
      await this.context.secrets.store(secretId(dataSource.id, key), value);
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private async updateSecrets(ds: DataSource, patch: SecretPatch): Promise<void> {
    const secrets = this.context.secrets;
    const passwordId = secretId(ds.id, 'password');
    const storage = needsPassword(ds) ? ds.passwordStorage : 'never';
    // A password that is not retyped follows the data source when its “Save” choice changes.
    const password = patch.password ?? this.sessionPasswords.get(ds.id) ?? (await secrets.get(passwordId));
    this.sessionPasswords.delete(ds.id);
    if (storage === 'forever' && password !== undefined) await secrets.store(passwordId, password);
    else await secrets.delete(passwordId);
    if (storage === 'session' && password !== undefined) this.sessionPasswords.set(ds.id, password);

    await this.updateSshSecret(ds, 'sshPassword', ds.ssh.enabled && ds.ssh.auth === 'password', patch.sshPassword);
    await this.updateSshSecret(ds, 'sshPassphrase', ds.ssh.enabled && ds.ssh.auth === 'key', patch.sshPassphrase);
  }

  private async updateSshSecret(ds: DataSource, key: SecretKey, used: boolean, value: string | undefined): Promise<void> {
    const id = secretId(ds.id, key);
    if (!used || value === '') await this.context.secrets.delete(id);
    else if (value !== undefined) await this.context.secrets.store(id, value);
  }
}

/** Data sources saved before Kafka and MongoDB support have no `kafka` or `mongo` block; they get the defaults. */
function withDefaults(dataSource: DataSource): DataSource {
  if (dataSource.kafka && dataSource.mongo) return dataSource;
  const defaults = createDataSourceSettings(dataSource.engine);
  return { ...dataSource, kafka: dataSource.kafka ?? defaults.kafka, mongo: dataSource.mongo ?? defaults.mongo };
}

function secretId(dataSourceId: string, key: SecretKey): string {
  return `datakit.dataSource/${dataSourceId}/${key}`;
}
