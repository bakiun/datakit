import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataSourceSettings,
  type LoadedPage,
  type ScriptStatement,
  type TableChange,
  type TableDataHostMessage,
  type TableDataWebviewMessage,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import type { TableRef } from '../../src/sql/tableDataPanel';
import { listedDataSources } from './tree';

// Needs the MySQL server from docker/docker-compose.yml (port 33306). Rows it adds are removed again.

const ALL = 'SELECT * FROM shop.customers';
const PAGED = `${ALL} ORDER BY id LIMIT 100 OFFSET 0`;

/** Statements as the page sends them; `unpaged` is given for queries that should be counted. */
function statements(...items: (string | [text: string, unpaged: string])[]): ScriptStatement[] {
  let from = 0;
  return items.map((item) => {
    const [text, unpaged] = typeof item === 'string' ? [item, undefined] : item;
    const statement: ScriptStatement = { text, from, to: from + text.length, ...(unpaged ? { unpaged } : {}) };
    from += text.length + 2;
    return statement;
  });
}

/** Stubs a `vscode.window` function for the length of `run`. */
async function stubbing<T>(name: 'showWarningMessage' | 'showSaveDialog', value: unknown, run: () => Promise<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

type Reply<T extends TableDataHostMessage['type']> = Extract<TableDataHostMessage, { type: T }>;

suite('Table data view', () => {
  let api: TestApi;
  let ref: TableRef;

  /** Sends a message as the page would and waits for the first reply of one of the given types. */
  async function send<T extends TableDataHostMessage['type']>(message: TableDataWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const received = new Promise<Reply<T>>((resolve) => {
      const listener = api.onDidPostTableData((posted) => {
        if (!types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve(posted.message as Reply<T>);
      });
    });
    await api.sendToTableData(ref, message);
    return received;
  }

  async function run(script: ScriptStatement[], autoCommit = true) {
    return send({ type: 'run', statements: script, autoCommit }, 'page', 'ran', 'runFailed', 'declined');
  }

  async function show(text = PAGED, unpaged = ALL): Promise<{ page: LoadedPage; summary?: string }> {
    const reply = await run(statements([text, unpaged]));
    assert.equal(reply.type, 'page', JSON.stringify(reply));
    return reply as Reply<'page'>;
  }

  async function submit(changes: TableChange[], page: LoadedPage, autoCommit = true) {
    return send({ type: 'submit', changes, autoCommit, statement: page.statement }, 'page', 'submitFailed', 'declined');
  }

  const column = (page: LoadedPage, name: string) => page.columns.findIndex((c) => c.name === name);
  const rowWith = (page: LoadedPage, name: string, value: string) => page.rows.findIndex((r) => r[column(page, name)] === value);

  async function child(node: ExplorerNode, label: string): Promise<ExplorerNode> {
    const children = await api.tree.getChildren(node);
    const text = (c: ExplorerNode) => {
      const item = api.tree.getTreeItem(c).label;
      return typeof item === 'string' ? item : item?.label;
    };
    const found = children.find((c) => text(c) === label);
    assert.ok(found, `${label} is listed`);
    return found;
  }

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension<TestApi>('bakiun.datakit');
    api = (await extension!.activate())!;
    const settings = { ...createDataSourceSettings('mysql'), name: 'shop-data', host: '127.0.0.1', port: '33306', user: 'app', database: 'shop' };
    const dataSource = await api.store.save(null, settings, { password: 'app-secret' });
    ref = { dataSourceId: dataSource.id, database: 'shop', table: 'customers' };
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.store.delete(d.id);
    }
  });

  test('a double-click on a table opens its data view; a single click does not', async () => {
    const root = (await listedDataSources(api)).find((n) => n.id === ref.dataSourceId)!;
    const table = await child(await child(await child(root, 'shop'), 'Tables'), 'customers');
    const command = api.tree.getTreeItem(table).command!;
    assert.equal(command.command, 'datakit.objectClicked');

    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await new Promise((resolve) => setTimeout(resolve, 600));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === 'customers · shop-data');
    assert.equal(tabs().length, 0, 'two clicks far apart are not a double-click');

    const loaded = new Promise<TableRef>((resolve) => api.onDidLoadTableData(resolve));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    assert.deepEqual(await loaded, ref, 'the page ran its starting script and showed the rows');
    assert.equal(tabs().length, 1);
  });

  test('shows the rows of the last query of a script, with a count and a summary', async () => {
    const reply = await run(statements('UPDATE shop.customers SET name = name WHERE id = 1', ['SELECT id, name FROM shop.customers ORDER BY id LIMIT 2', 'SELECT id, name FROM shop.customers']));
    assert.equal(reply.type, 'page');
    const { page, summary } = reply as Reply<'page'>;
    assert.deepEqual(page.columns.map((c) => c.name), ['id', 'name']);
    assert.equal(page.rows.length, 2);
    assert.equal(page.total, 3);
    assert.deepEqual(page.editable, { database: 'shop', table: 'customers', rowKey: ['id'] });
    assert.match(summary ?? '', /^2 statements: UPDATE 1 row affected \(.+\) · SELECT 2 rows$/);
  });

  test('explains why a result cannot be edited', async () => {
    const reason = async (text: string) => ((await run(statements(text))) as Reply<'page'>).page.readOnlyReason;
    assert.equal(await reason('SELECT c.name AS who FROM shop.customers c'), 'Read-only: add id to the SELECT to edit rows.');
    assert.equal(await reason('SELECT c.name, o.total FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.id'), 'Read-only: the result combines several tables.');
    assert.equal(await reason('SELECT 1 + 1 AS two'), 'Read-only: the result does not come from a table.');
    // MySQL reports some view columns as coming from the view's base table; either way the rows stay read-only.
    assert.match((await reason('SELECT * FROM shop.order_totals')) ?? '', /^(Views are shown read-only\.|Read-only: )/);
  });

  test('reports the failing statement and what ran before it', async () => {
    const reply = await run(statements("INSERT INTO shop.customers (name, email) VALUES ('Script', 'script@example.com')", 'SELECT nope FROM shop.customers'));
    assert.equal(reply.type, 'runFailed');
    assert.match((reply as Reply<'runFailed'>).message, /^Statement 2 of 2 failed: Unknown column 'nope'/);
    assert.match((reply as Reply<'runFailed'>).summary ?? '', /^Ran before it: INSERT 1 row affected/);
    await run(statements("DELETE FROM shop.customers WHERE email = 'script@example.com'"));
  });

  test('edits rows of an aliased query through the table it reads', async () => {
    let { page } = await show('SELECT id, name AS full_name, email FROM shop.customers ORDER BY id LIMIT 10', 'SELECT id, name AS full_name, email FROM shop.customers');
    const ada = rowWith(page, 'email', 'ada@example.com');
    let reply = await submit([{ kind: 'update', row: ada, values: { full_name: 'Ada L.' } }], page);
    page = (reply as Reply<'page'>).page;
    assert.equal(page.rows[rowWith(page, 'email', 'ada@example.com')]?.[column(page, 'full_name')], 'Ada L.');
    reply = await submit([{ kind: 'update', row: rowWith(page, 'email', 'ada@example.com'), values: { full_name: 'Ada Lovelace' } }], page);
    assert.equal(reply.type, 'page');
  });

  test('inserts, updates and deletes rows', async () => {
    let { page } = await show();
    let reply = await submit([{ kind: 'insert', values: { name: 'E2E Tester', email: 'e2e@example.com' } }], page);
    assert.equal(reply.type, 'page');
    page = (reply as Reply<'page'>).page;
    assert.equal(page.total, 4);
    assert.match((reply as Reply<'page'>).summary ?? '', /^1 inserted — committed/);

    reply = await submit([{ kind: 'update', row: rowWith(page, 'email', 'e2e@example.com'), values: { name: 'Renamed' } }], page);
    page = (reply as Reply<'page'>).page;
    assert.equal(page.rows[rowWith(page, 'email', 'e2e@example.com')]?.[column(page, 'name')], 'Renamed');

    reply = await submit([{ kind: 'delete', row: rowWith(page, 'email', 'e2e@example.com') }], page);
    assert.equal((reply as Reply<'page'>).page.total, 3);
  });

  test('a failing change writes nothing', async () => {
    const { page } = await show();
    const failed = await submit(
      [
        { kind: 'insert', values: { name: 'Dup', email: 'dup@example.com' } },
        { kind: 'insert', values: { name: 'Dup', email: 'dup@example.com' } },
      ],
      page,
    );
    assert.equal(failed.type, 'submitFailed');
    assert.match((failed as Reply<'submitFailed'>).message, /Duplicate entry/);
    assert.equal((await show()).page.total, 3);
  });

  test('manual mode and script transactions wait for commit or rollback', async () => {
    const { page } = await show();
    const opened = send(
      { type: 'run', statements: statements("INSERT INTO shop.customers (name, email) VALUES ('Pending', 'pending@example.com')"), autoCommit: false },
      'transaction',
    );
    assert.deepEqual(await opened, { type: 'transaction', open: true, changes: 1 });
    let reply = await send({ type: 'rollback', statement: page.statement }, 'page');
    assert.equal(reply.page.total, 3);
    assert.equal(reply.summary, 'Rolled back 1 change');

    const started = send({ type: 'run', statements: statements('START TRANSACTION', "DELETE FROM shop.customers WHERE id = 3"), autoCommit: true }, 'transaction');
    assert.equal((await started).open, true, 'a transaction the script opens stays open');
    reply = await send({ type: 'rollback', statement: page.statement }, 'page');
    assert.equal(reply.page.total, 3);
  });

  test('exports the shown rows in every format', async () => {
    await show();
    const folder = await mkdtemp(join(tmpdir(), 'datakit-export-'));
    const exported = async (format: 'csv' | 'json' | 'sql' | 'markdown' | 'xlsx', name: string) => {
      const file = join(folder, name);
      const notice = await stubbing('showSaveDialog', vscode.Uri.file(file), () => send({ type: 'export', format, scope: 'page' }, 'notice'));
      assert.equal(notice.message, `Saved 3 rows to ${name}.`);
      return readFile(file);
    };
    assert.match((await exported('csv', 'c.csv')).toString(), /^id,name,email,created_at\n1,Ada Lovelace,ada@example.com,/);
    const json = JSON.parse((await exported('json', 'c.json')).toString()) as Record<string, unknown>[];
    assert.deepEqual(json[0], { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', created_at: json[0]?.created_at });
    assert.match((await exported('sql', 'c.sql')).toString(), /^INSERT INTO `customers` \(`id`, `name`, `email`, `created_at`\) VALUES \(1, 'Ada Lovelace', 'ada@example.com', '\d{4}-/);
    assert.match((await exported('markdown', 'c.md')).toString(), /^\| id \| name +\| email +\| created_at +\|/);
    assert.equal((await exported('xlsx', 'c.xlsx')).subarray(0, 2).toString(), 'PK', 'an xlsx file is a zip archive');
  });

  /** Applies ALTER TABLE statements; on success the host also runs the shown query again. */
  async function alter(statements: string[]) {
    let refreshed: Promise<unknown> = Promise.resolve();
    const reply = await new Promise<Reply<'structure' | 'alterFailed' | 'declined'>>((resolve) => {
      const listener = api.onDidPostTableData((posted) => {
        if (posted.message.type !== 'structure' && posted.message.type !== 'alterFailed' && posted.message.type !== 'declined') return;
        listener.dispose();
        if (posted.message.type === 'structure') {
          refreshed = new Promise((done) => {
            const next = api.onDidPostTableData((p) => p.message.type === 'page' && (next.dispose(), done(undefined)));
          });
        }
        resolve(posted.message as Reply<'structure' | 'alterFailed' | 'declined'>);
      });
      void api.sendToTableData(ref, { type: 'alterTable', statements });
    });
    await refreshed;
    return reply;
  }

  test('exports every row of a paged query, in its order', async () => {
    const [query] = statements(['SELECT id, email FROM shop.customers ORDER BY id DESC LIMIT 2', 'SELECT id, email FROM shop.customers']);
    const shown = await run([{ ...query!, unlimited: 'SELECT id, email FROM shop.customers ORDER BY id DESC' }]);
    assert.equal((shown as Reply<'page'>).page.rows.length, 2);
    const file = join(await mkdtemp(join(tmpdir(), 'datakit-export-')), 'all.csv');
    const notice = await stubbing('showSaveDialog', vscode.Uri.file(file), () => send({ type: 'export', format: 'csv', scope: 'all' }, 'notice'));
    assert.equal(notice.message, 'Saved 3 rows to all.csv.');
    assert.deepEqual((await readFile(file, 'utf8')).trim().split('\n'), ['id,email', '3,grace@example.com', '2,linus@example.com', '1,ada@example.com']);
  });

  test('changes the table structure and shows it again', async () => {
    await show();
    const added = await alter(['ALTER TABLE `shop`.`customers`\n  ADD COLUMN `e2e_note` varchar(20) NULL COMMENT \'from the e2e test\' AFTER `name`']);
    assert.equal(added.type, 'structure', JSON.stringify(added));
    const column = (added as Reply<'structure'>).structure.columns.find((c) => c.name === 'e2e_note');
    assert.deepEqual([column?.columnType, column?.comment], ['varchar(20)', 'from the e2e test']);
    assert.deepEqual((await show()).page.columns.map((c) => c.name), ['id', 'name', 'e2e_note', 'email', 'created_at']);

    const dropped = await alter(['ALTER TABLE `shop`.`customers`\n  DROP COLUMN `e2e_note`']);
    assert.equal(dropped.type, 'structure');
    assert.ok(!(dropped as Reply<'structure'>).structure.columns.some((c) => c.name === 'e2e_note'));
  });

  test('reports a failing ALTER TABLE and refuses one inside an open transaction', async () => {
    const failed = await alter(['ALTER TABLE `shop`.`customers`\n  DROP COLUMN `nope`']);
    assert.equal(failed.type, 'alterFailed');
    assert.match((failed as Reply<'alterFailed'>).message, /nope/);

    const { page } = await show();
    await send({ type: 'run', statements: statements("INSERT INTO shop.customers (name, email) VALUES ('Tx', 'tx@example.com')"), autoCommit: false }, 'transaction');
    const refused = await alter(['ALTER TABLE `shop`.`customers`\n  ADD COLUMN `x` int NULL']);
    assert.deepEqual(refused, { type: 'alterFailed', message: 'Commit or roll back the open transaction first: ALTER TABLE would commit it.' });
    await send({ type: 'rollback', statement: page.statement }, 'page');
  });

  test('production data sources ask before writing', async () => {
    const dataSource = api.store.get(ref.dataSourceId)!;
    await api.store.save(dataSource.id, { ...dataSource, environment: 'production' }, {});
    const { page } = await show();
    // Declining is not an error: the page only stops waiting.
    const refused = await stubbing('showWarningMessage', undefined, () => run(statements('DELETE FROM shop.customers WHERE id = 3')));
    assert.deepEqual(refused, { type: 'declined', message: 'Nothing was run.' });
    const failed = await stubbing('showWarningMessage', undefined, () => submit([{ kind: 'delete', row: 0 }], page));
    assert.deepEqual(failed, { type: 'declined', message: 'Nothing was written.' });
    const altered = await stubbing('showWarningMessage', undefined, () => alter(['ALTER TABLE `shop`.`customers`\n  ADD COLUMN `x` int NULL']));
    assert.deepEqual(altered, { type: 'declined', message: 'Nothing was changed.' });
    const reads = await stubbing('showWarningMessage', undefined, () => run(statements(ALL)));
    assert.equal(reads.type, 'page', 'queries run without asking');
    assert.equal((await show()).page.total, 3);
  });
});
