import * as assert from 'node:assert/strict';
import { createDataSourceSettings, type ScriptStatement, type TableDataHostMessage, type TableDataInit, type TableDataWebviewMessage } from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs the MySQL server from docker/docker-compose.yml (port 33306).

type Reply<T extends TableDataHostMessage['type']> = Extract<TableDataHostMessage, { type: T }>;

function statements(...texts: string[]): ScriptStatement[] {
  let from = 0;
  return texts.map((text) => {
    const statement = { text, from, to: from + text.length };
    from += text.length + 2;
    return statement;
  });
}

/** Stubs a `vscode.window` function for the length of `run`. */
async function stubbing<T>(name: 'showWarningMessage' | 'showInputBox', value: unknown, run: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

const tabLabels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => t.label);

/** The tab model updates a moment after a panel changes. */
async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(check(), what);
}

suite('Query console', () => {
  let api: TestApi;
  let dataSourceId: string;

  function labelOf(node: ExplorerNode): string {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  }

  async function child(node: ExplorerNode | undefined, label: string): Promise<ExplorerNode> {
    const found = (await api.tree.getChildren(node)).find((c) => labelOf(c) === label);
    assert.ok(found, `${label} is listed`);
    return found;
  }

  const root = async () => (await listedDataSources(api)).find((n) => n.id === dataSourceId)!;

  /** The next message of one of `types` that a console's page gets. */
  function next<T extends TableDataHostMessage['type']>(consoleId: string | null, ...types: T[]): Promise<Reply<T> & { consoleId: string }> {
    return new Promise((resolve) => {
      const listener = api.onDidPostConsole((posted) => {
        if ((consoleId && posted.consoleId !== consoleId) || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve({ ...(posted.message as Reply<T>), consoleId: posted.consoleId });
      });
    });
  }

  /** Runs `open` and waits for the console's page to start. */
  async function opened(open: () => Thenable<unknown>): Promise<{ consoleId: string; init: TableDataInit }> {
    const init = next(null, 'init');
    await open();
    const message = await init;
    return { consoleId: message.consoleId, init: message.init };
  }

  async function send<T extends TableDataHostMessage['type']>(consoleId: string, message: TableDataWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const reply = next(consoleId, ...types);
    await api.sendToConsole(consoleId, message);
    return reply;
  }

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('bakiun.datakit')!.activate())!;
    const settings = { ...createDataSourceSettings('mysql'), name: 'shop-console', host: '127.0.0.1', port: '33306', user: 'app', database: 'shop' };
    dataSourceId = (await api.store.save(null, settings, { password: 'app-secret' })).id;
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.consoles.deleteFor(d.id);
      await api.store.delete(d.id);
    }
  });

  test('New Query Console on a database opens console-1.sql in it and lists it under Consoles', async () => {
    const shop = await child(await root(), 'shop');
    const { consoleId, init } = await opened(() => vscode.commands.executeCommand('datakit.newConsole', shop));
    assert.equal(init.structure, null);
    assert.equal(init.script, '');
    assert.equal(init.console?.name, 'console-1.sql');
    assert.equal(init.console?.database, 'shop');
    assert.ok(init.console?.databases.includes('shop'));
    assert.ok(init.tables.includes('customers'));
    await eventually(() => tabLabels().includes('console-1.sql · shop-console'), 'the console tab is open');

    const consoles = await child(await root(), 'Consoles');
    assert.deepEqual((await api.tree.getChildren(consoles)).map(labelOf), ['console-1.sql']);
    assert.equal(api.consoles.get(consoleId)?.database, 'shop');
  });

  test('runs a script, follows USE and edits rows of one table', async () => {
    const [queryConsole] = api.consoles.list(dataSourceId);
    const id = queryConsole!.id;
    const switched = next(id, 'database');
    const logs: string[] = [];
    const listener = api.onDidPostConsole((p) => p.message.type === 'log' && logs.push(p.message.text));
    const reply = await send(
      id,
      { type: 'run', statements: statements('USE information_schema', 'SELECT id, name FROM shop.customers ORDER BY id LIMIT 10'), autoCommit: true },
      'page',
      'runFailed',
    );
    listener.dispose();
    assert.equal(reply.type, 'page', JSON.stringify(reply));
    const { page } = reply as Reply<'page'>;
    assert.deepEqual(page.editable, { database: 'shop', table: 'customers', rowKey: ['id'] });
    assert.equal((await switched).database, 'information_schema');
    assert.equal(api.consoles.get(id)?.database, 'information_schema');
    assert.ok(logs.some((l) => /^Statement 1 of 2: USE 0 rows affected/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /^Statement 2 of 2: SELECT \d+ rows \(/.test(l)), logs.join('\n'));

    const back = await send(id, { type: 'useDatabase', database: 'shop' }, 'database');
    assert.equal(back.database, 'shop');
    assert.ok(back.tables.includes('orders'));

    const script = statements('SELECT 1', 'SELECT nope FROM customers');
    const failed = await send(id, { type: 'run', statements: script, autoCommit: true }, 'runFailed');
    assert.match(failed.message, /^Statement 2 of 2 failed: Unknown column 'nope'/);
    assert.deepEqual(failed.failed, { from: script[1]!.from, to: script[1]!.to });
  });

  test('explains a statement without running it', async () => {
    const id = api.consoles.list(dataSourceId)[0]!.id;
    const count = async () =>
      Number((await send(id, { type: 'run', statements: statements('SELECT COUNT(*) FROM customers'), autoCommit: true }, 'page')).page.rows[0]?.[0]);
    const before = await count();
    const plan = await send(id, { type: 'explain', statement: 'DELETE FROM customers WHERE id = 1' }, 'plan', 'planFailed');
    assert.equal(plan.type, 'plan', JSON.stringify(plan));
    const { columns, rows } = plan as Reply<'plan'>;
    assert.ok(columns.some((c) => c.name === 'select_type'));
    assert.equal(rows.length, 1);
    assert.equal(await count(), before, 'EXPLAIN DELETE removed nothing');

    const failed = await send(id, { type: 'explain', statement: 'SELECT * FROM no_such_table' }, 'plan', 'planFailed');
    assert.equal(failed.type, 'planFailed');
  });

  test('saves the script and opens the console again with it and its database', async () => {
    const queryConsole = api.consoles.list(dataSourceId)[0]!;
    await api.sendToConsole(queryConsole.id, { type: 'script', script: 'SELECT 42;' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await api.consoles.read(queryConsole), 'SELECT 42;');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const node = await child(await child(await root(), 'Consoles'), 'console-1.sql');
    const command = api.tree.getTreeItem(node).command!;
    const { init } = await opened(() => vscode.commands.executeCommand(command.command, ...(command.arguments ?? [])));
    assert.equal(init.script, 'SELECT 42;');
    assert.equal(init.console?.database, 'shop');
  });

  test('Open in query console takes the script of a data view into a new console', async () => {
    const table = await child(await child(await child(await root(), 'shop'), 'Tables'), 'orders');
    const ref = { dataSourceId, database: 'shop', table: 'orders' };
    const loaded = new Promise((resolve) => api.onDidLoadTableData(resolve));
    await vscode.commands.executeCommand('datakit.openTableData', table);
    await loaded;
    const { consoleId, init } = await opened(() => api.sendToTableData(ref, { type: 'openConsole', script: 'SELECT * FROM orders' }));
    assert.equal(init.console?.name, 'console-2.sql');
    assert.equal(init.console?.database, 'shop');
    assert.equal(init.script, 'SELECT * FROM orders');
    assert.equal(api.consoles.get(consoleId)?.dataSourceId, dataSourceId);
  });

  test('renames and deletes a console', async () => {
    const queryConsole = api.consoles.list(dataSourceId).find((c) => c.name === 'console-2.sql')!;
    const taken = await stubbing('showInputBox', 'console-1', () => vscode.commands.executeCommand('datakit.renameConsole', queryConsole.id));
    assert.equal(taken, undefined);
    assert.equal(api.consoles.get(queryConsole.id)?.name, 'console-2.sql', 'a name in use is refused');

    await stubbing('showInputBox', 'open orders', () => vscode.commands.executeCommand('datakit.renameConsole', queryConsole.id));
    assert.equal(api.consoles.get(queryConsole.id)?.name, 'open orders.sql');
    await eventually(() => tabLabels().includes('open orders.sql · shop-console'), 'the tab shows the new name');

    await stubbing('showWarningMessage', 'Delete', () => vscode.commands.executeCommand('datakit.deleteConsole', queryConsole.id));
    assert.equal(api.consoles.get(queryConsole.id), undefined);
    assert.equal(await api.consoles.read(queryConsole), '');
    await eventually(() => !tabLabels().includes('open orders.sql · shop-console'), 'its tab is closed');
  });

  test('deleting a data source deletes its consoles', async () => {
    const settings = { ...createDataSourceSettings('mysql'), name: 'short-lived', host: '127.0.0.1', port: '33306', user: 'app' };
    const dataSource = await api.store.save(null, settings, { password: 'app-secret' });
    await opened(() => vscode.commands.executeCommand('datakit.newConsole', api.tree.nodeFor(dataSource.id)));
    assert.equal(api.consoles.list(dataSource.id).length, 1);
    await stubbing('showWarningMessage', 'Delete', () => vscode.commands.executeCommand('datakit.deleteDataSource', api.tree.nodeFor(dataSource.id)));
    assert.equal(api.consoles.list(dataSource.id).length, 0);
  });
});
