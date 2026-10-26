import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHome } from '@datakit/adapter-common';
import {
  createDataSourceSettings,
  formatServerVersion,
  toSettings,
  validateDataSource,
  type DataSourceSettings,
  type EditorHostMessage,
  type EditorState,
  type EditorWebviewMessage,
  type FileField,
  type SecretPatch,
  type Secrets,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { Services } from '../services';
import { renderWebviewHtml, webviewRoot } from '../webview/webviewHtml';
import { connectNewDataSource } from './actions';
import { driverFor } from './drivers';
import { CancelledError, errorMessage } from './prompts';
import { resolveSecrets } from './sessionManager';

const NEW_KEY = 'new';

const BROWSE_TITLES: Record<FileField, string> = {
  'ssh.privateKeyPath': 'Select SSH Private Key',
  'ssl.caFile': 'Select CA Certificate',
  'ssl.certFile': 'Select Client Certificate',
  'ssl.keyFile': 'Select Client Key',
};

/** The “New data source” / “Edit data source” editor tab. One tab per data source, one for a new one. */
export class DataSourceEditor {
  private static readonly editors = new Map<string, DataSourceEditor>();
  private static readonly loaded = new vscode.EventEmitter<string | null>();
  /** Fires with the data source id (null for a new one) when an editor's page has loaded and asked for its data. */
  static readonly onDidLoad = DataSourceEditor.loaded.event;

  static show(services: Services, id?: string): void {
    const existing = DataSourceEditor.editors.get(id ?? NEW_KEY);
    if (existing) existing.panel.reveal();
    else new DataSourceEditor(services, id ?? null);
  }

  static close(id: string): void {
    DataSourceEditor.editors.get(id)?.panel.dispose();
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly services: Services,
    private id: string | null,
  ) {
    const extensionUri = services.context.extensionUri;
    this.panel = vscode.window.createWebviewPanel('datakit.dataSourceEditor', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot(extensionUri)],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icons', 'mysql.svg');
    this.panel.webview.html = renderWebviewHtml(this.panel.webview, extensionUri, 'dataSourceEditor', this.title());
    this.panel.webview.onDidReceiveMessage((message: EditorWebviewMessage) => void this.handle(message));
    this.panel.onDidDispose(() => DataSourceEditor.editors.delete(this.id ?? NEW_KEY));
    DataSourceEditor.editors.set(id ?? NEW_KEY, this);
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
      settings: dataSource ? toSettings(dataSource) : createDataSourceSettings('mysql'),
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
    }
    // A password that is not saved is still used for the connection that follows.
    const overrides: Secrets = patch.password !== undefined ? { password: patch.password } : {};

    if (close) this.panel.dispose();
    else {
      this.panel.title = this.title();
      this.post({ type: 'saved', state: await this.state() });
    }

    if (isNew) {
      await connectNewDataSource(this.services, dataSource, overrides);
      return;
    }
    void vscode.window.showInformationMessage(`Saved “${dataSource.name}”.`);
    if (wasActive) {
      sessions.reconnect(dataSource.id, overrides).catch((error: unknown) => {
        if (error instanceof CancelledError) return;
        void vscode.window.showErrorMessage(`Could not reconnect “${dataSource.name}”: ${errorMessage(error)}`);
      });
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
