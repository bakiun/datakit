import * as assert from 'node:assert/strict';
import { createDataSourceSettings, type ScriptStatement, type TableDataHostMessage, type TableDataInit } from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs the MySQL server from docker/docker-compose.yml (port 33306).

function statements(...texts: string[]): ScriptStatement[] {
  let from = 0;
  return texts.map((text) => {
    const statement = { text, from, to: from + text.length };
    from += text.length + 2;
    return statement;
  });
}

async function eventually(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(await check(), what);
}

suite('Query history', () => {
  let api: TestApi;
  let dataSourceId: string;

  const labelOf = (node: ExplorerNode) => {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  };
  async function child(node: ExplorerNode | undefined, label: string): Promise<ExplorerNode> {
    const found = (await api.tree.getChildren(node)).find((c) => labelOf(c) === label);
    assert.ok(found, `${label} is listed`);
    return found;
  }
  const root = async () => (await listedDataSources(api)).find((n) => n.id === dataSourceId)!;
  const sqls = () => api.history.list().map((e) => e.sql);

  /** Runs `open` and waits for a console page to start. */
  function consoleOpened(open: () => Thenable<unknown>): Promise<{ consoleId: string; init: TableDataInit }> {
    const started = new Promise<{ consoleId: string; init: TableDataInit }>((resolve) => {
      const listener = api.onDidPostConsole(({ consoleId, message }) => {
        if (message.type !== 'init') return;
        listener.dispose();
        resolve({ consoleId, init: message.init });
      });
    });
    return Promise.resolve(open()).then(() => started);
  }

  async function runInConsole(consoleId: string, ...texts: string[]): Promise<TableDataHostMessage> {
    const reply = new Promise<TableDataHostMessage>((resolve) => {
      const listener = api.onDidPostConsole((p) => {
        if (p.consoleId !== consoleId || !['page', 'ran', 'runFailed'].includes(p.message.type)) return;
        listener.dispose();
        resolve(p.message);
      });
    });
    await api.sendToConsole(consoleId, { type: 'run', statements: statements(...texts), autoCommit: true });
    return reply;
  }

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('datakit.datakit')!.activate())!;
    const settings = { ...createDataSourceSettings('mysql'), name: 'shop-history', host: '127.0.0.1', port: '33306', user: 'app', database: 'shop' };
    dataSourceId = (await api.store.save(null, settings, { password: 'app-secret' })).id;
    await api.history.clear();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.consoles.deleteFor(d.id);
      await api.history.deleteFor(d.id);
      await api.store.delete(d.id);
    }
  });

  test('keeps what the user ran, newest first, but not the query a data view opens with', async () => {
    const table = await child(await child(await child(await root(), 'shop'), 'Tables'), 'customers');
    const loaded = new Promise((resolve) => api.onDidLoadTableData(resolve));
    await vscode.commands.executeCommand('datakit.openTableData', table);
    await loaded;
    assert.deepEqual(sqls(), [], 'the opening query is not kept');

    const ref = { dataSourceId, database: 'shop', table: 'customers' };
    const ran = new Promise((resolve) => {
      const listener = api.onDidPostTableData((p) => p.message.type === 'page' && (listener.dispose(), resolve(p)));
    });
    await api.sendToTableData(ref, { type: 'run', statements: statements('SELECT id FROM shop.customers ORDER BY id LIMIT 1'), autoCommit: true });
    await ran;
    await eventually(() => sqls().length === 1, 'the data view query is kept');
    const [first] = api.history.list();
    assert.equal(first?.database, 'shop');
    assert.equal(first?.ok, true);
    assert.match(first?.detail ?? '', /^1 row \(\d+\.\d{4} s\)$/);

    const { consoleId } = await consoleOpened(() => vscode.commands.executeCommand('datakit.newConsole', api.tree.nodeFor(dataSourceId)));
    await runInConsole(consoleId, 'SELECT 1', 'SELECT nope FROM customers');
    await eventually(() => sqls().length === 3, 'both console statements are kept');
    assert.deepEqual(sqls(), ['SELECT nope FROM customers', 'SELECT 1', 'SELECT id FROM shop.customers ORDER BY id LIMIT 1']);
    const failed = api.history.list()[0]!;
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /Unknown column 'nope'/);

    await runInConsole(consoleId, 'SELECT 1');
    await eventually(() => sqls()[0] === 'SELECT 1', 'running it again moves it to the top');
    assert.equal(sqls().length, 3);

    const item = api.historyTree.getTreeItem(api.history.list()[0]!);
    assert.equal(item.label, 'SELECT 1');
    assert.match(String(item.description), /^\d\d:\d\d · shop-history$/);
    assert.equal((item.iconPath as vscode.ThemeIcon).id, 'pass');
    assert.equal((api.historyTree.getTreeItem(failed).iconPath as vscode.ThemeIcon).id, 'error');
  });

  test('opening an entry adds it to the open console, or opens a new console with it', async () => {
    const [queryConsole] = api.consoles.list(dataSourceId);
    const entry = api.history.list().find((e) => e.sql.startsWith('SELECT id'))!;
    await vscode.commands.executeCommand('datakit.openHistoryEntry', entry);
    // The page appends it to its script and saves the script.
    const expected = 'SELECT id FROM shop.customers ORDER BY id LIMIT 1;';
    await eventually(async () => (await api.consoles.read(queryConsole!)) === expected, 'the console script ends with the query');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const { init } = await consoleOpened(() => vscode.commands.executeCommand('datakit.openHistoryEntry', entry));
    assert.equal(init.console?.name, 'console-2.sql');
    assert.equal(init.console?.database, 'shop');
    assert.equal(init.script, entry.sql);
  });

  test('copies, removes and clears entries', async () => {
    const entry = api.history.list()[0]!;
    await vscode.commands.executeCommand('datakit.copyHistoryEntry', entry);
    assert.equal(await vscode.env.clipboard.readText(), entry.sql);

    await vscode.commands.executeCommand('datakit.deleteHistoryEntry', entry);
    assert.ok(!api.history.get(entry.id));

    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.showWarningMessage;
    window.showWarningMessage = async () => 'Clear';
    try {
      await vscode.commands.executeCommand('datakit.clearHistory');
    } finally {
      window.showWarningMessage = original;
    }
    assert.deepEqual(api.history.list(), []);
  });
});
