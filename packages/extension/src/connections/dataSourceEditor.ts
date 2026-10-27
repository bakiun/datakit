import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '@datakit/adapter-common';
import {
  createDataSourceSettings,
  ENGINES,
  formatServerVersion,
  suggestDataSourceName,
  toSettings,
  validateDataSource,
  type DataSourceSettings,
  type EditorHostMessage,
  type EditorState,
  type EditorWebviewMessage,
  type EngineId,
  type Environment,
  type FileField,
  readPanelRef,
  type SecretPatch,
  type Secrets,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { Services } from '../services';
import { openWebviewPanel, renderWebviewHtml } from '../webview/webviewHtml';
import { connectNewDataSource } from './actions';
import { driverFor } from './drivers';
import { CancelledError, errorMessage, showConnectionError } from './prompts';
import { resolveSecrets } from './sessionManager';

const NEW_KEY = 'new';
/** The engine of the data source created last; a new form starts with it. */
const LAST_ENGINE_KEY = 'datakit.lastNewEngine';

/** What a new data source starts with when the command knows it, e.g. the environment folder it was run on. */
export interface NewDataSourcePreset {
  engine?: EngineId;
  environment?: Environment;
}

const BROWSE_TITLES: Record<FileField, string> = {
  'ssh.privateKeyPath': 'Select SSH Private Key',
  'ssl.caFile': 'Select CA Certificate',
  'ssl.certFile': 'Select Client Certificate',
  'ssl.keyFile': 'Select Client Key',
};

/** The “New data source” / “Edit data source” editor tab. One tab per data source, one for a new one. */
export class DataSourceEditor {
  static readonly viewType = 'datakit.dataSourceEditor';
  private static readonly editors = new Map<string, DataSourceEditor>();
  private static readonly loaded = new vscode.EventEmitter<string | null>();
  /** Fires with the data source id (null for a new one) when an editor's page has loaded and asked for its data. */
  static readonly onDidLoad = DataSourceEditor.loaded.event;

  static show(services: Services, id?: string, preset: NewDataSourcePreset = {}): void {
    const existing = DataSourceEditor.editors.get(id ?? NEW_KEY);
    if (existing) existing.panel.reveal();
    else new DataSourceEditor(services, id ?? null, preset);
  }

  static close(id: string): void {
    DataSourceEditor.editors.get(id)?.panel.dispose();
  }

  /**
   * Builds the editor again on a tab VS Code restores after a reload of the window; the page brings its draft back
   * itself. False when the data source it edited is gone or already has an editor open.
   */
  static restore(services: Services, panel: vscode.WebviewPanel, state: unknown): boolean {
    const ref = readPanelRef.dataSourceEditor(state);
    if (!ref || DataSourceEditor.editors.has(ref.dataSourceId ?? NEW_KEY)) return false;
    if (ref.dataSourceId !== null && !services.store.get(ref.dataSourceId)) return false;
    new DataSourceEditor(services, ref.dataSourceId, {}, panel);
    return true;
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly services: Services,
    private id: string | null,
    private readonly preset: NewDataSourcePreset,
    restored?: vscode.WebviewPanel,
  ) {
    const extensionUri = services.context.extensionUri;
    this.panel = openWebviewPanel(DataSourceEditor.viewType, this.title(), extensionUri, restored);
    this.panel.iconPath = this.icon();
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'dataSourceEditor', this.title(), { dataSourceId: id });
    this.panel.webview.onDidReceiveMessage((message: EditorWebviewMessage) => void this.handle(message));
    this.panel.onDidDispose(() => DataSourceEditor.editors.delete(this.id ?? NEW_KEY));
    DataSourceEditor.editors.set(id ?? NEW_KEY, this);
  }

  /** The engine's icon once the data source exists; a new one, which can still switch engines, shows the plain database. */
  private icon(): vscode.Uri {
    const engine = this.id ? this.services.store.get(this.id)?.engine : undefined;
    return vscode.Uri.joinPath(this.services.context.extensionUri, 'media', 'icons', `${engine ?? 'mysql'}.svg`);
  }

  /** A new form: the engine asked for or used last, and the environment of the folder it was opened from. */
  private newSettings(): DataSourceSettings {
    const last = this.services.context.globalState.get<string>(LAST_ENGINE_KEY);
    const engine = this.preset.engine ?? ENGINES.find((e) => e.id === last)?.id ?? 'mysql';
    const settings = createDataSourceSettings(engine);
    if (this.preset.environment) settings.environment = this.preset.environment;
    return settings;
  }

  private title(): string {
    const dataSource = this.id ? this.services.store.get(this.id) : undefined;
    return dataSource ? `Data Source: ${dataSource.name}` : 'New Data Source';
  }

  private post(message: EditorHostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async handle(message: EditorWebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'init', state: await this.state() });
        DataSourceEditor.loaded.fire(this.id);
        break;
      case 'test':
        await this.test(message.settings, message.secrets);
        break;
      case 'save':
        await this.save(message.settings, message.secrets, message.close);
        break;
      case 'cancel':
        this.panel.dispose();
        break;
      case 'browse':
        await this.browse(message.field, message.current);
        break;
    }
  }

  private async state(): Promise<EditorState> {
    const { store } = this.services;
    const dataSource = this.id ? store.get(this.id) : undefined;
    return {
      mode: dataSource ? 'edit' : 'new',
      id: dataSource?.id ?? null,
      settings: dataSource ? toSettings(dataSource) : this.newSettings(),
      storedSecrets: dataSource ? await store.storedSecrets(dataSource) : { password: false, sshPassword: false, sshPassphrase: false },
      otherNames: store
        .list()
        .filter((d) => d.id !== this.id)
        .map((d) => d.name),
    };
  }

  private async savedSecrets(): Promise<Secrets> {
    const dataSource = this.id ? this.services.store.get(this.id) : undefined;
    return dataSource ? this.services.store.secrets(dataSource) : {};
  }

  private async test(settings: DataSourceSettings, patch: SecretPatch): Promise<void> {
    // The name does not matter for a test; every connection field does.
    const { name: _name, ...errors } = validateDataSource(settings, []);
    const firstError = Object.values(errors)[0];
    if (firstError) {
      this.post({ type: 'testResult', ok: false, message: firstError });
      return;
    }
    try {
      const { secrets } = await resolveSecrets(settings, await this.savedSecrets(), patch);
      const result = await driverFor(settings.engine).test(settings, secrets);
      this.post({
        type: 'testResult',
        ok: true,
        message: `Succeeded — ${formatServerVersion(result.serverVersion)} · ${result.latencyMs} ms`,
      });
    } catch (error) {
      const message = error instanceof CancelledError ? 'Test cancelled.' : errorMessage(error);
      this.post({ type: 'testResult', ok: false, message });
    }
  }

  private async save(settings: DataSourceSettings, patch: SecretPatch, close: boolean): Promise<void> {
    const { store, sessions } = this.services;
    const otherNames = store
      .list()
      .filter((d) => d.id !== this.id)
      .map((d) => d.name);
    // A data source saved without a name is named after its endpoint, as the form's placeholder shows.
    if (!settings.name.trim()) settings = { ...settings, name: suggestDataSourceName(settings, otherNames) };
    const errors = validateDataSource(settings, otherNames);
    const firstError = Object.values(errors)[0];
    if (firstError) {
      this.post({ type: 'saveFailed', message: firstError, errors });
      return;
    }

    const isNew = this.id === null;
    const wasActive = !isNew && sessions.status(this.id!) !== 'idle';
    let dataSource;
    try {
      dataSource = await store.save(this.id, settings, patch);
    } catch (error) {
      this.post({ type: 'saveFailed', message: `Could not save: ${errorMessage(error)}` });
      return;
    }
    if (isNew) {
      DataSourceEditor.editors.delete(NEW_KEY);
      DataSourceEditor.editors.set(dataSource.id, this);
      this.id = dataSource.id;
      await this.services.context.globalState.update(LAST_ENGINE_KEY, dataSource.engine);
    }
    // A password that is not saved is still used for the connection that follows.
    const overrides: Secrets = patch.password !== undefined ? { password: patch.password } : {};

    if (close) this.panel.dispose();
    else {
      this.panel.title = this.title();
      this.panel.iconPath = this.icon();
      this.post({ type: 'saved', state: await this.state() });
    }

    if (isNew) {
      await connectNewDataSource(this.services, dataSource, overrides);
      return;
    }
    // Apply says “Saved.” in the form; after Save the tab is gone, so the status bar says it.
    if (close) vscode.window.setStatusBarMessage(`$(check) Saved “${dataSource.name}”`, 4000);
    if (wasActive) {
      sessions.reconnect(dataSource.id, overrides).catch((error: unknown) =>
        showConnectionError(dataSource, error, 'datakit.connectDataSource', `Saved “${dataSource.name}”, but could not reconnect`),
      );
    }
  }

  private async browse(field: FileField, current: string): Promise<void> {
    const start = current.trim() ? expandHome(current) : field === 'ssh.privateKeyPath' ? join(homedir(), '.ssh') : homedir();
    const files = await vscode.window.showOpenDialog({
      title: BROWSE_TITLES[field],
      defaultUri: vscode.Uri.file(start),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select',
    });
    const file = files?.[0];
    if (file) this.post({ type: 'fileSelected', field, path: file.fsPath });
  }
}
