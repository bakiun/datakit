import * as assert from 'node:assert/strict';
import { createDataSourceSettings, type DataSource, type DataSourceSettings } from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { DataSourceNode, ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs the MySQL server from docker/docker-compose.yml (port 33306).

function mysqlSettings(name: string, patch: Partial<DataSourceSettings> = {}): DataSourceSettings {
  return { ...createDataSourceSettings('mysql'), name, host: '127.0.0.1', port: '33306', user: 'app', database: 'shop', ...patch };
}

function labelOf(api: TestApi, node: ExplorerNode): string {
  const label = api.tree.getTreeItem(node).label;
  return typeof label === 'string' ? label : (label?.label ?? '');
}

/** The tab model updates after the panel is created, so tab checks wait for it. */
async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const editorTabs = (label: string) => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === label);

/** Answers the next modal warning (the delete confirmation) with `answer`. */
async function answeringWarning<T>(answer: string, run: () => Thenable<T>): Promise<T> {
  const original = vscode.window.showWarningMessage;
  (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => answer;
  try {
    return await run();
  } finally {
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
  }
}

/** Replaces a `vscode.window` function while `run` runs. */
async function stubbing<T>(name: 'showInputBox' | 'showQuickPick', stub: (...args: unknown[]) => unknown, run: () => Thenable<T> | Promise<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = stub;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

suite('Data sources', () => {
  let api: TestApi;

  async function rootNode(dataSource: DataSource): Promise<DataSourceNode> {
    const node = (await listedDataSources(api)).find((n) => n.id === dataSource.id);
    assert.ok(node, 'the data source is listed');
    return node;
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<TestApi>('bakiun.datakit');
    assert.ok(extension);
    api = await extension.activate();
    assert.ok(api, 'the extension returns its test API in test mode');
  });

  teardown(async () => {
    for (const dataSource of api.store.list()) {
      await api.sessions.disconnect(dataSource.id);
      await api.store.delete(dataSource.id);
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('contributes the commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['addDataSource', 'editDataSource', 'refreshDataSource', 'deleteDataSource', 'connectDataSource', 'disconnectDataSource', 'refreshAll']) {
      assert.ok(commands.includes(`datakit.${id}`), id);
    }
  });

  test('saves a data source with its password in Secret Storage', async () => {
    const dataSource = await api.store.save(null, mysqlSettings(' shop-dev '), { password: 'app-secret' });
    assert.equal(dataSource.name, 'shop-dev');
    assert.deepEqual(await api.store.storedSecrets(dataSource), { password: true, sshPassword: false, sshPassphrase: false });
    assert.equal(labelOf(api, await rootNode(dataSource)), 'shop-dev');
    assert.equal(api.tree.getTreeItem(await rootNode(dataSource)).description, '127.0.0.1:33306');
  });

  test('groups data sources into folders by environment', async () => {
    await api.store.save(null, mysqlSettings('shop-dev'), { password: 'app-secret' });
    const prod = await api.store.save(null, mysqlSettings('shop-prod', { environment: 'production' }), { password: 'app-secret' });
    await api.store.save(null, mysqlSettings('shop-prod-2', { environment: 'production' }), { password: 'app-secret' });
    const folders = await api.tree.getChildren();
    assert.deepEqual(
      folders.map((f) => `${labelOf(api, f)} ${api.tree.getTreeItem(f).description}`),
      ['Development 1', 'Production 2'],
    );
    assert.equal(api.tree.getTreeItem(folders[1]!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepEqual((await api.tree.getChildren(folders[1])).map((n) => labelOf(api, n)), ['shop-prod', 'shop-prod-2']);
    assert.equal(api.tree.getParent(await rootNode(prod))?.itemId, 'env/production');
    await api.view.reveal(await rootNode(prod), { select: true, focus: false });

    // Choosing another environment moves the data source to that folder.
    await api.store.save(prod.id, mysqlSettings('shop-prod', { environment: 'staging' }), {});
    assert.deepEqual((await api.tree.getChildren()).map((f) => labelOf(api, f)), ['Development', 'Staging', 'Production']);
    assert.equal(api.tree.getParent(await rootNode(prod))?.itemId, 'env/staging');
  });

  test('expanding connects and lists databases, folders and tables', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('shop-dev'), { password: 'app-secret' });
    const node = await rootNode(dataSource);

    const databases = await api.tree.getChildren(node);
    assert.equal(api.sessions.status(dataSource.id), 'connected');
    assert.match(String(api.tree.getTreeItem(node).description), /^mysql 8\.4$/);
    const shop = databases.find((n) => n.kind === 'database' && n.name === 'shop');
    assert.ok(shop, 'the shop database is listed');
    assert.equal(api.tree.getTreeItem(shop).description, 'default');

    const folders = await api.tree.getChildren(shop);
    assert.deepEqual(
      folders.map((f) => `${labelOf(api, f)} ${api.tree.getTreeItem(f).description}`),
      ['Tables 2', 'Views 1', 'Procedures 1', 'Functions 1'],
    );
    const tables = await api.tree.getChildren(folders[0]);
    assert.deepEqual(
      tables.map((t) => labelOf(api, t)),
      ['customers', 'orders'],
    );
  });

  test('the filter searches connected data sources and matches the others by name', async () => {
    const shopDev = await api.store.save(null, mysqlSettings('shop-dev'), { password: 'app-secret' });
    await api.store.save(null, mysqlSettings('other', { port: '1' }), { password: 'unused' });
    await api.sessions.connect(shopDev.id);
    const messages: (string | undefined)[] = [];
    const listener = api.tree.onDidChangeMessage((m) => messages.push(m));
    const item = (node: ExplorerNode) => api.tree.getTreeItem(node);
    try {
      api.tree.setFilter(' ORDER ');
      const roots = await listedDataSources(api);
      assert.deepEqual(roots.map((n) => labelOf(api, n)), ['shop-dev']);
      assert.match(String(messages.at(-1)), /^Showing what matches “ORDER”\. Data sources that are not connected are matched by name only\.$/);
      assert.equal(item(roots[0]!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

      const shop = (await api.tree.getChildren(roots[0])).find((n) => labelOf(api, n) === 'shop');
      assert.ok(shop, 'the database with matches is listed');
      assert.equal(item(shop).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const folders = await api.tree.getChildren(shop);
      assert.deepEqual(folders.map((f) => `${labelOf(api, f)} ${item(f).description}`), ['Tables 1', 'Views 1']);
      const tables = await api.tree.getChildren(folders[0]);
      assert.deepEqual(tables.map((t) => labelOf(api, t)), ['orders']);
      assert.deepEqual((item(tables[0]!).label as vscode.TreeItemLabel).highlights, [[0, 5]]);
      assert.equal(api.sessions.status(api.store.list().find((d) => d.name === 'other')!.id), 'idle', 'the filter does not connect');

      api.tree.setFilter('oth');
      assert.deepEqual((await listedDataSources(api)).map((n) => labelOf(api, n)), ['other']);
      api.tree.setFilter('no such thing');
      assert.deepEqual(await api.tree.getChildren(), []);
      assert.match(String(messages.at(-1)), /^Nothing matches “no such thing”\./);

      api.tree.setFilter('');
      assert.deepEqual((await listedDataSources(api)).map((n) => labelOf(api, n)), ['other', 'shop-dev']);
      assert.equal(messages.at(-1), undefined);
    } finally {
      listener.dispose();
      api.tree.setFilter('');
    }
  });

  test('a wrong password shows the server error under the data source', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('broken'), { password: 'wrong' });
    const children = await api.tree.getChildren(await rootNode(dataSource));
    assert.equal(api.sessions.status(dataSource.id), 'failed');
    assert.equal(children.length, 1);
    assert.match(labelOf(api, children[0]!), /Access denied for user 'app'/);
    // The error offers Retry and Edit Data Source beside it.
    assert.equal(api.tree.getTreeItem(children[0]!).contextValue, 'connectionError');
  });

  test('a password that is not saved is asked for once per connection', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('ask-me', { passwordStorage: 'never' }), {});
    assert.deepEqual(await api.store.storedSecrets(dataSource), { password: false, sshPassword: false, sshPassphrase: false });
    let asked = 0;
    const askPassword = async () => {
      asked++;
      return 'app-secret';
    };
    await stubbing('showInputBox', askPassword, async () => {
      await api.sessions.connect(dataSource.id);
      // A data view's own session and a refresh reuse the password the open session was given.
      const dedicated = await api.sessions.openDedicatedSql(dataSource.id);
      await dedicated.close();
      await api.sessions.reconnect(dataSource.id);
      assert.equal(asked, 1);
      await api.sessions.disconnect(dataSource.id);
      await api.sessions.connect(dataSource.id);
      assert.equal(asked, 2, 'a new connection asks again');
    });
    assert.deepEqual(await api.store.storedSecrets(dataSource), { password: false, sshPassword: false, sshPassphrase: false });
  });

  test('dismissing the password prompt folds the data source instead of asking again', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('dismissed', { passwordStorage: 'never' }), {});
    const node = await rootNode(dataSource);
    const children = await stubbing('showInputBox', async () => undefined, () => api.tree.getChildren(node));
    assert.deepEqual(children, []);
    assert.equal(api.sessions.status(dataSource.id), 'idle');
    assert.notEqual((await rootNode(dataSource)).itemId, node.itemId, 'the node gets a new id, so it shows collapsed');
  });

  test('a command from the Command Palette uses the only data source it fits', async () => {
    const connected = await api.store.save(null, mysqlSettings('connected'), { password: 'app-secret' });
    await api.store.save(null, mysqlSettings('idle'), { password: 'app-secret' });
    await api.sessions.connect(connected.id);
    const noPicker = () => {
      throw new Error('no list is shown');
    };
    await stubbing('showQuickPick', noPicker, () => vscode.commands.executeCommand('datakit.disconnectDataSource'));
    assert.equal(api.sessions.status(connected.id), 'idle');
  });

  test('refresh, disconnect and delete work from the commands', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('shop-dev'), { password: 'app-secret' });
    let node = await rootNode(dataSource);
    await api.tree.getChildren(node);
    const firstSession = api.sessions.session(dataSource.id);

    await vscode.commands.executeCommand('datakit.refreshDataSource', node);
    assert.equal(api.sessions.status(dataSource.id), 'connected');
    assert.notEqual(api.sessions.session(dataSource.id), firstSession, 'refresh opens a new session');

    await vscode.commands.executeCommand('datakit.disconnectDataSource', node);
    assert.equal(api.sessions.status(dataSource.id), 'idle');
    node = await rootNode(dataSource);
    assert.equal(api.tree.getTreeItem(node).contextValue, 'dataSource.disconnected.mysql');

    await answeringWarning('Delete', () => vscode.commands.executeCommand('datakit.deleteDataSource', node));
    assert.equal(api.store.get(dataSource.id), undefined);
    assert.deepEqual(await api.store.storedSecrets(dataSource), { password: false, sshPassword: false, sshPassphrase: false });
  });

  test('cancelling the delete confirmation keeps the data source', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('keep-me'), { password: 'app-secret' });
    const node = await rootNode(dataSource);
    await answeringWarning('Cancel', () => vscode.commands.executeCommand('datakit.deleteDataSource', node));
    assert.ok(api.store.get(dataSource.id));
  });

  test('“Until restart” keeps the password out of Secret Storage', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('session-only', { passwordStorage: 'session' }), { password: 'app-secret' });
    assert.deepEqual(await api.store.storedSecrets(dataSource), { password: true, sshPassword: false, sshPassphrase: false });
    await api.tree.getChildren(await rootNode(dataSource));
    assert.equal(api.sessions.status(dataSource.id), 'connected');

    // Switching to “Forever” without retyping moves the password into Secret Storage.
    const updated = await api.store.save(dataSource.id, { ...mysqlSettings('session-only'), passwordStorage: 'forever' }, {});
    assert.equal((await api.store.secrets(updated)).password, 'app-secret');
  });

  test('New Data Source opens the editor tab once, and its page loads', async () => {
    const loaded = new Promise<string | null>((resolve) => {
      const listener = api.onDidLoadEditor((id) => {
        listener.dispose();
        resolve(id);
      });
    });
    await vscode.commands.executeCommand('datakit.addDataSource');
    assert.equal(await loaded, null, 'the Vue page started and asked the extension for its data');
    const tab = await waitFor(() => editorTabs('New Data Source')[0], 'the editor tab');
    assert.ok(tab.input instanceof vscode.TabInputWebview);
    await vscode.commands.executeCommand('datakit.addDataSource');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(editorTabs('New Data Source').length, 1);
  });

  test('Edit opens a tab named after the data source', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('shop-dev'), { password: 'app-secret' });
    await vscode.commands.executeCommand('datakit.editDataSource', await rootNode(dataSource));
    await waitFor(() => editorTabs('Data Source: shop-dev')[0], 'the editor tab');
  });

  test('Edit also takes the data source id, as the Edit Data Source button of a connection error passes it', async () => {
    const dataSource = await api.store.save(null, mysqlSettings('by-id'), { password: 'app-secret' });
    await vscode.commands.executeCommand('datakit.editDataSource', dataSource.id);
    await waitFor(() => editorTabs('Data Source: by-id')[0], 'the editor tab');
  });
});
