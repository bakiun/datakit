import * as assert from 'node:assert/strict';
import { createDataSourceSettings, type TableDataHostMessage } from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

// Needs the MySQL server from docker/docker-compose.yml (port 33306). Tabs that VS Code restores after a reload of the
// window: the serializers build the same panel on the panel VS Code gives them, or close it quietly.

/** A webview panel as VS Code hands one to a serializer. */
function freshPanel(viewType: string): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(viewType, 'Restoring…', vscode.ViewColumn.Active, { enableScripts: true });
}

function disposed(panel: vscode.WebviewPanel): Promise<void> {
  return new Promise((resolve) => panel.onDidDispose(() => resolve()));
}

/** Resolves with whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

suite('Restoring tabs after a reload of the window', () => {
  let api: TestApi;
  let dataSourceId: string;
  const errors: string[] = [];
  let showError: typeof vscode.window.showErrorMessage;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<TestApi>('bakiun.datakit');
    api = (await extension!.activate())!;
    const settings = { ...createDataSourceSettings('mysql'), name: 'restore-shop', host: '127.0.0.1', port: '33306', user: 'app', database: 'shop' };
    dataSourceId = (await api.store.save(null, settings, { password: 'app-secret' })).id;
    // Restoring never shows an error; any that is shown fails the suite.
    showError = vscode.window.showErrorMessage;
    (vscode.window as unknown as Record<string, unknown>).showErrorMessage = async (message: string) => {
      errors.push(message);
      return undefined;
    };
  });

  suiteTeardown(async () => {
    (vscode.window as unknown as Record<string, unknown>).showErrorMessage = showError;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.sessions.disconnect(dataSourceId);
    await api.store.delete(dataSourceId);
    assert.deepEqual(errors, []);
  });

  test('a data view comes back on the restored panel and opens its table', async () => {
    const panel = freshPanel('datakit.tableData');
    const ref = { dataSourceId, database: 'shop', table: 'customers' };
    const init = new Promise<Extract<TableDataHostMessage, { type: 'init' }>>((resolve) => {
      const listener = api.onDidPostTableData(({ ref: posted, message }) => {
        if (posted.table !== ref.table || message.type !== 'init') return;
        listener.dispose();
        resolve(message);
      });
    });
    assert.equal(await api.restorePanel('datakit.tableData', panel, { panel: ref, parts: {} }), true);
    assert.equal(panel.title, 'customers · restore-shop');
    assert.match(panel.webview.html, /data-view="tableData"/);
    // The page keeps the panel's identity, so the next restart restores it again.
    assert.match(panel.webview.html, /data-panel="[^"]*customers/);
    // The page sends `ready` once it has loaded; this sends it too, in case the test is quicker.
    await api.sendToTableData(ref, { type: 'ready' });
    const message = await init;
    assert.equal(message.init.structure?.table, 'customers');
    assert.equal(message.init.dataSourceName, 'restore-shop');
    // The same table restored again while it is open: the second tab closes instead of making a twin.
    const twin = freshPanel('datakit.tableData');
    const gone = disposed(twin);
    assert.equal(await api.restorePanel('datakit.tableData', twin, { panel: ref }), false);
    assert.ok(await within(gone, 2000), 'the twin tab closes');
    panel.dispose();
  });

  test('a tab whose data source was deleted closes quietly', async () => {
    for (const [viewType, ref] of [
      ['datakit.tableData', { dataSourceId: 'deleted-source', database: 'shop', table: 'customers' }],
      ['datakit.dataSourceEditor', { dataSourceId: 'deleted-source' }],
      ['datakit.mongoCollection', { dataSourceId: 'deleted-source', database: 'shop', collection: 'orders' }],
      ['datakit.redisKeys', { dataSourceId: 'deleted-source', database: 0 }],
      ['datakit.kafkaWorkspace', { dataSourceId: 'deleted-source' }],
      ['datakit.queryConsole', { consoleId: 'deleted-console' }],
    ] as const) {
      const panel = freshPanel(viewType);
      const gone = disposed(panel);
      assert.equal(await api.restorePanel(viewType, panel, { panel: ref }), false, viewType);
      assert.ok(await within(gone, 2000), `${viewType} closes`);
    }
  });

  test('a state without a panel, e.g. from an older version, closes the tab', async () => {
    for (const state of [undefined, null, {}, { panel: { dataSourceId: 42 } }]) {
      const panel = freshPanel('datakit.tableData');
      const gone = disposed(panel);
      assert.equal(await api.restorePanel('datakit.tableData', panel, state), false);
      assert.ok(await within(gone, 2000));
    }
  });

  test('a data view of a table dropped since closes once it looks for the table', async () => {
    const panel = freshPanel('datakit.tableData');
    const ref = { dataSourceId, database: 'shop', table: 'dropped_since_restart' };
    const failed: string[] = [];
    const listener = api.onDidPostTableData(({ ref: posted, message }) => {
      if (posted.table === ref.table && message.type === 'initFailed') failed.push(message.message);
    });
    const gone = disposed(panel);
    assert.equal(await api.restorePanel('datakit.tableData', panel, { panel: ref }), true);
    await api.sendToTableData(ref, { type: 'ready' });
    assert.ok(await within(gone, 10_000), 'the tab closes');
    listener.dispose();
    assert.deepEqual(failed, [], 'no error is shown on the page');
  });

  test('a console comes back with its script from its file', async () => {
    const created = await api.consoles.create(dataSourceId, 'shop', 'SELECT 42 AS answer;');
    const panel = freshPanel('datakit.queryConsole');
    const loaded = new Promise<void>((resolve) => {
      const listener = api.onDidLoadConsole((id) => {
        if (id !== created.id) return;
        listener.dispose();
        resolve();
      });
    });
    const init = new Promise<Extract<TableDataHostMessage, { type: 'init' }>>((resolve) => {
      const listener = api.onDidPostConsole(({ consoleId, message }) => {
        if (consoleId !== created.id || message.type !== 'init') return;
        listener.dispose();
        resolve(message);
      });
    });
    assert.equal(await api.restorePanel('datakit.queryConsole', panel, { panel: { consoleId: created.id } }), true);
    await api.sendToConsole(created.id, { type: 'ready' });
    await loaded;
    assert.equal((await init).init.script, 'SELECT 42 AS answer;');
    panel.dispose();
    await api.consoles.delete(created.id);
  });

  test('a new data source form comes back as a new form', async () => {
    const panel = freshPanel('datakit.dataSourceEditor');
    assert.equal(await api.restorePanel('datakit.dataSourceEditor', panel, { panel: { dataSourceId: null } }), true);
    assert.equal(panel.title, 'New Data Source');
    panel.dispose();
  });
});
