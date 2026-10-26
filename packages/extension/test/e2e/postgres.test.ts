import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataSourceSettings,
  type DataSourceSettings,
  type LoadedPage,
  type ScriptStatement,
  type TableChange,
  type TableDataHostMessage,
  type TableDataInit,
  type TableDataWebviewMessage,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import type { TableRef } from '../../src/sql/tableDataPanel';
import { listedDataSources } from './tree';

// Needs PostgreSQL from docker/docker-compose.yml (port 35432, user app / app-secret, sample databases shop and analytics).
// Rows and tables the tests add are removed again.

type Reply<T extends TableDataHostMessage['type']> = Extract<TableDataHostMessage, { type: T }>;

function pgSettings(patch: Partial<DataSourceSettings> = {}): DataSourceSettings {
  return { ...createDataSourceSettings('postgres'), name: 'pg-shop', host: '127.0.0.1', port: '35432', user: 'app', database: 'shop', ...patch };
}

function statements(...texts: string[]): ScriptStatement[] {
  let from = 0;
  return texts.map((text) => {
    const statement = { text, from, to: from + text.length };
    from += text.length + 2;
    return statement;
  });
}

/** Stubs a `vscode.window` function for the length of `run`. */
async function stubbing<T>(name: 'showWarningMessage' | 'showSaveDialog' | 'showInformationMessage', value: unknown, run: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

suite('PostgreSQL', () => {
  let api: TestApi;
  let dataSourceId: string;
  const products: TableRef = { dataSourceId: '', database: 'shop', schema: 'inventory', table: 'products' };
  const notes: TableRef = { dataSourceId: '', database: 'shop', schema: 'public', table: 'e2e_notes' };

  const labelOf = (node: ExplorerNode) => {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  };
  const root = async () => (await listedDataSources(api)).find((n) => n.id === dataSourceId)!;

  async function child(node: ExplorerNode | undefined, label: string): Promise<ExplorerNode> {
    const children = await api.tree.getChildren(node);
    const found = children.find((c) => labelOf(c) === label);
    assert.ok(found, `${label} is listed among ${children.map(labelOf).join(', ')}`);
    return found;
  }

  /** Runs SQL on the data source's shared session, for setting up and checking. */
  async function sql(text: string): Promise<unknown[][]> {
    const result = await (await api.sessions.connectSql(dataSourceId)).execute(text);
    return result.kind === 'rows' ? result.rows : [];
  }

  /** Sends a message to a data view as its page would and waits for the first reply of one of the given types. */
  async function sendToView<T extends TableDataHostMessage['type']>(ref: TableRef, message: TableDataWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const received = new Promise<Reply<T>>((resolve) => {
      const listener = api.onDidPostTableData((posted) => {
        if (posted.ref.table !== ref.table || posted.ref.schema !== ref.schema || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve(posted.message as Reply<T>);
      });
    });
    await api.sendToTableData(ref, message);
    return received;
  }

  async function openView(ref: TableRef): Promise<void> {
    const loaded = new Promise<TableRef>((resolve) => {
      const listener = api.onDidLoadTableData((loadedRef) => {
        if (loadedRef.table !== ref.table) return;
        listener.dispose();
        resolve(loadedRef);
      });
    });
    const schema = await child(await child(await root(), ref.database), ref.schema!);
    const table = await child(await child(schema, 'Tables'), ref.table);
    await vscode.commands.executeCommand('datakit.openTableData', table);
    assert.deepEqual(await loaded, ref);
  }

  async function show(ref: TableRef, text: string): Promise<LoadedPage> {
    const reply = await sendToView(ref, { type: 'run', statements: statements(text), autoCommit: true }, 'page', 'runFailed');
    assert.equal(reply.type, 'page', JSON.stringify(reply));
    return (reply as Reply<'page'>).page;
  }

  async function submit(ref: TableRef, changes: TableChange[], page: LoadedPage) {
    return sendToView(ref, { type: 'submit', changes, autoCommit: true, statement: page.statement }, 'page', 'submitFailed');
  }

  /** The next message of one of `types` that a console's page gets. */
  function nextFromConsole<T extends TableDataHostMessage['type']>(consoleId: string | null, ...types: T[]): Promise<Reply<T> & { consoleId: string }> {
    return new Promise((resolve) => {
      const listener = api.onDidPostConsole((posted) => {
        if ((consoleId && posted.consoleId !== consoleId) || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve({ ...(posted.message as Reply<T>), consoleId: posted.consoleId });
      });
    });
  }

  async function sendToConsole<T extends TableDataHostMessage['type']>(consoleId: string, message: TableDataWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const reply = nextFromConsole(consoleId, ...types);
    await api.sendToConsole(consoleId, message);
    return reply;
  }

  async function openConsole(open: () => Thenable<unknown>): Promise<{ consoleId: string; init: TableDataInit }> {
    const init = nextFromConsole(null, 'init');
    await open();
    const message = await init;
    return { consoleId: message.consoleId, init: message.init };
  }

  const column = (page: LoadedPage, name: string) => page.columns.findIndex((c) => c.name === name);

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('bakiun.datakit')!.activate())!;
    dataSourceId = (await api.store.save(null, pgSettings(), { password: 'app-secret' })).id;
    products.dataSourceId = dataSourceId;
    notes.dataSourceId = dataSourceId;
    await sql('DROP TABLE IF EXISTS public.e2e_notes');
    await sql('CREATE TABLE public.e2e_notes (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)');
    await sql("INSERT INTO public.e2e_notes (body) VALUES ('first'), ('second')");
    api.tree.reload(dataSourceId);
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sql('DROP TABLE IF EXISTS public.e2e_notes').catch(() => undefined);
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.consoles.deleteFor(d.id);
      await api.store.delete(d.id);
    }
  });

  test('the tree lists databases, then schemas, then the objects of a schema by kind', async () => {
    const source = await root();
    const databases = await api.tree.getChildren(source);
    assert.deepEqual(databases.map(labelOf).slice(0, 3), ['shop', 'analytics', 'postgres']);
    const shop = databases[0]!;
    assert.equal(api.tree.getTreeItem(shop).description, 'default');
    assert.equal(api.tree.getTreeItem(shop).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);

    const schemas = await api.tree.getChildren(shop);
    assert.deepEqual(schemas.map(labelOf), ['public', 'inventory', 'information_schema', 'pg_catalog']);
    assert.equal(api.tree.getTreeItem(schemas[0]!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.equal(api.tree.getTreeItem(schemas[0]!).contextValue, 'pgSchema');

    const folders = await api.tree.getChildren(schemas[0]);
    assert.deepEqual(folders.map(labelOf), ['Tables', 'Views', 'Materialized views', 'Sequences', 'Procedures', 'Functions', 'Types']);
    assert.deepEqual((await api.tree.getChildren(folders[0])).map(labelOf), ['customers', 'e2e_notes', 'orders']);
    const stats = await child(folders[2], 'customer_stats');
    assert.equal(api.tree.getTreeItem(stats).contextValue, 'pgMaterializedView');
    const total = await child(folders[5], 'customer_total');
    assert.equal(api.tree.getTreeItem(total).description, '(cid integer)');
    const status = await child(folders[6], 'order_status');
    assert.deepEqual([api.tree.getTreeItem(status).description, api.tree.getTreeItem(status).contextValue], ['enum', 'pgType']);

    // Another database opens a connection of its own.
    const events = await child(await child(await child(await child(source, 'analytics'), 'public'), 'Tables'), 'events');
    assert.equal(api.tree.getTreeItem(events).contextValue, 'pgTable');
  });

  test('the filter finds tables, views and routines in the schemas of the database it connects to', async () => {
    await api.sessions.connect(dataSourceId);
    const messages: (string | undefined)[] = [];
    const listener = api.tree.onDidChangeMessage((m) => messages.push(m));
    const item = (node: ExplorerNode) => api.tree.getTreeItem(node);
    try {
      api.tree.setFilter('customer');
      const roots = await listedDataSources(api);
      assert.deepEqual(roots.map(labelOf), ['pg-shop']);
      assert.match(String(messages.at(-1)), /^Showing what matches “customer”\. PostgreSQL data sources are searched in the database they connect to\.$/);

      const databases = await api.tree.getChildren(roots[0]);
      assert.deepEqual(databases.map(labelOf), ['shop']);
      const schemas = await api.tree.getChildren(databases[0]);
      assert.deepEqual(schemas.map(labelOf), ['public']);
      assert.equal(item(schemas[0]!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const folders = await api.tree.getChildren(schemas[0]);
      assert.deepEqual(folders.map((f) => `${labelOf(f)} ${item(f).description}`), ['Tables 1', 'Materialized views 1', 'Functions 1']);
      assert.equal(item(folders[0]!).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const tables = await api.tree.getChildren(folders[0]);
      assert.deepEqual(tables.map(labelOf), ['customers']);
      assert.deepEqual((item(tables[0]!).label as vscode.TreeItemLabel).highlights, [[0, 8]]);
    } finally {
      listener.dispose();
      api.tree.setFilter('');
    }
  });

  test('a table in another schema opens with its types, enums and booleans, and writes typed values back', async () => {
    await openView(products);
    let page = await show(products, 'SELECT * FROM inventory.products ORDER BY sku LIMIT 100');
    assert.deepEqual(page.editable, { database: 'shop', schema: 'inventory', table: 'products', rowKey: ['sku'] });
    assert.deepEqual(
      page.columns.map((c) => c.type),
      ['text', 'text', 'unit', 'numeric', 'int8', 'bool', 'bytea', 'inet', 'jsonb'],
    );
    assert.deepEqual(page.columns[column(page, 'unit')]?.column?.enumValues, ['piece', 'kg', 'litre']);
    assert.deepEqual(page.columns[column(page, 'in_stock')]?.column?.enumValues, ['true', 'false']);
    const book = page.rows.findIndex((r) => r[0] === 'BOOK-1');
    assert.equal(page.rows[book]?.[column(page, 'stock')], '9007199254740993');
    assert.equal(page.rows[book]?.[column(page, 'in_stock')], 'true');
    assert.deepEqual(page.rows[book]?.[column(page, 'photo')], { hex: 'cafe', length: 2 });

    let reply = await submit(products, [{ kind: 'update', row: book, values: { stock: '9007199254740995', unit: 'kg', in_stock: 'false', attributes: '{"pages": 67}' } }], page);
    assert.equal(reply.type, 'page', JSON.stringify(reply));
    page = (reply as Reply<'page'>).page;
    assert.deepEqual(
      ['stock', 'unit', 'in_stock', 'attributes'].map((name) => page.rows[book]?.[column(page, name)]),
      ['9007199254740995', 'kg', 'false', '{"pages": 67}'],
    );
    reply = await submit(products, [{ kind: 'update', row: book, values: { stock: '9007199254740993', unit: 'piece', in_stock: 'true', attributes: '{"pages": 66}' } }], page);
    page = (reply as Reply<'page'>).page;

    reply = await submit(products, [{ kind: 'insert', values: { sku: 'E2E-1', name: 'E2E', price: '1.5', supplier_ip: '::1' } }], page);
    assert.equal(reply.type, 'page', JSON.stringify(reply));
    page = (reply as Reply<'page'>).page;
    const added = page.rows.findIndex((r) => r[0] === 'E2E-1');
    assert.deepEqual([page.rows[added]?.[column(page, 'price')], page.rows[added]?.[column(page, 'unit')]], ['1.50', 'piece']);
    reply = await submit(products, [{ kind: 'delete', row: added }], page);
    assert.ok(!(reply as Reply<'page'>).page.rows.some((r) => r[0] === 'E2E-1'));

    const failed = await submit(products, [{ kind: 'update', row: book, values: { unit: 'gallon' } }], (reply as Reply<'page'>).page);
    assert.equal(failed.type, 'submitFailed');
    assert.match((failed as Reply<'submitFailed'>).message, /invalid input value for enum inventory\.unit: "gallon"/);
  });

  test('explains why rows cannot be edited', async () => {
    const reason = async (text: string) => (await show(products, text)).readOnlyReason;
    assert.equal(await reason('SELECT * FROM inventory.stock_movements'), 'Read-only: the table has no primary key or unique key to identify rows.');
    assert.match((await reason('SELECT * FROM public.customer_stats')) ?? '', /^Materialized views are read-only/);
    assert.equal(await reason('SELECT name FROM inventory.products'), 'Read-only: add sku to the SELECT to edit rows.');
  });

  test('exports SQL INSERT statements with PostgreSQL quoting', async () => {
    await show(products, "SELECT sku, name, price, photo FROM inventory.products WHERE sku = 'BOOK-1'");
    const file = join(await mkdtemp(join(tmpdir(), 'datakit-pg-export-')), 'products.sql');
    const notice = await stubbing('showSaveDialog', vscode.Uri.file(file), () => sendToView(products, { type: 'export', format: 'sql', scope: 'all' }, 'notice'));
    assert.equal(notice.message, 'Saved 1 row to products.sql.');
    assert.equal(
      await readFile(file, 'utf8'),
      `INSERT INTO "products" ("sku", "name", "price", "photo") VALUES ('BOOK-1', 'Notes on the Analytical Engine', '19.90', decode('cafe', 'hex'));\n`,
    );
  });

  test('shows the DDL of the table', async () => {
    // The host opens the DDL in an editor before it returns.
    await api.sendToTableData(products, { type: 'viewDdl' });
    const text = vscode.window.activeTextEditor?.document.getText() ?? '';
    assert.match(text, /^CREATE TABLE inventory\.products \(\n {4}sku text NOT NULL,/);
    assert.match(text, /CONSTRAINT products_pkey PRIMARY KEY \(sku\)/);
  });

  test('applies a structure change set in one transaction, or nothing of it', async () => {
    await openView(notes);
    const failed = await new Promise<Reply<'alterFailed'>>((resolve) => {
      const listener = api.onDidPostTableData((posted) => {
        if (posted.message.type !== 'alterFailed') return;
        listener.dispose();
        resolve(posted.message);
      });
      void api.sendToTableData(notes, {
        type: 'alterTable',
        statements: ['ALTER TABLE "public"."e2e_notes"\n  ADD COLUMN "tag" text', 'ALTER TABLE "public"."e2e_notes"\n  ADD COLUMN "nope" no_such_type'],
      });
    });
    assert.equal(failed.message, 'type "no_such_type" does not exist. Nothing was changed.');
    assert.deepEqual(await sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'e2e_notes' AND column_name = 'tag'"), [['0']]);

    const changed = await sendToView(
      notes,
      { type: 'alterTable', statements: ['ALTER TABLE "public"."e2e_notes"\n  ADD COLUMN "tag" text', 'COMMENT ON COLUMN "public"."e2e_notes"."tag" IS \'From e2e\''] },
      'structure',
      'alterFailed',
    );
    assert.equal(changed.type, 'structure', JSON.stringify(changed));
    const tag = (changed as Reply<'structure'>).structure.columns.find((c) => c.name === 'tag');
    assert.deepEqual([tag?.columnType, tag?.comment], ['text', 'From e2e']);
  });

  test('a console on a schema runs there, switches schema and database, and shows notices and plans', async () => {
    const inventory = await child(await child(await root(), 'shop'), 'inventory');
    const { consoleId, init } = await openConsole(() => vscode.commands.executeCommand('datakit.newConsole', inventory));
    assert.equal(init.dialect, 'postgres');
    assert.equal(init.console?.database, 'shop');
    assert.equal(init.console?.schema, 'inventory');
    assert.deepEqual(init.console?.schemas, ['public', 'inventory', 'information_schema', 'pg_catalog']);
    assert.ok(init.tables.includes('products'));
    assert.equal(api.consoles.get(consoleId)?.schema, 'inventory');

    const counted = await sendToConsole(consoleId, { type: 'run', statements: statements('SELECT count(*) FROM products'), autoCommit: true }, 'page', 'runFailed');
    assert.equal(counted.type, 'page', JSON.stringify(counted));

    const switched = await sendToConsole(consoleId, { type: 'useSchema', schema: 'public' }, 'database');
    assert.equal(switched.schema, 'public');
    assert.ok(switched.tables.includes('customers'));

    const logs: string[] = [];
    const listener = api.onDidPostConsole((p) => p.consoleId === consoleId && p.message.type === 'log' && logs.push(p.message.text));
    const ran = await sendToConsole(consoleId, { type: 'run', statements: statements('CALL mark_shipped(1)', "UPDATE orders SET status = 'paid' WHERE id = 1"), autoCommit: true }, 'ran', 'runFailed');
    listener.dispose();
    assert.equal(ran.type, 'ran', JSON.stringify(ran));
    assert.ok(logs.includes('NOTICE: Order 1 shipped'), logs.join('\n'));

    const plan = await sendToConsole(consoleId, { type: 'explain', statement: 'SELECT * FROM customers WHERE id = 1' }, 'plan', 'planFailed');
    assert.equal(plan.type, 'plan', JSON.stringify(plan));
    assert.deepEqual((plan as Reply<'plan'>).columns.map((c) => c.name), ['QUERY PLAN']);
    const analyzed = await sendToConsole(consoleId, { type: 'explain', statement: "DELETE FROM e2e_notes WHERE body = 'first'", analyze: true }, 'plan', 'planFailed');
    assert.match((analyzed as Reply<'plan'>).rows.map((r) => String(r[0])).join('\n'), /actual time=/);
    assert.deepEqual(await sql("SELECT count(*) FROM public.e2e_notes WHERE body = 'first'"), [['1']], 'EXPLAIN ANALYZE was rolled back');

    const other = await sendToConsole(consoleId, { type: 'useDatabase', database: 'analytics' }, 'database');
    assert.deepEqual([other.database, other.schema, other.tables], ['analytics', 'public', ['events']]);
    const events = await sendToConsole(consoleId, { type: 'run', statements: statements('SELECT name FROM events ORDER BY id'), autoCommit: true }, 'page', 'runFailed');
    assert.deepEqual((events as Reply<'page'>).page.rows, [['signup'], ['checkout']]);
    assert.equal(api.consoles.get(consoleId)?.database, 'analytics');
  });

  test('Stop cancels a running statement', async () => {
    const queryConsole = api.consoles.list(dataSourceId)[0]!;
    const failed = nextFromConsole(queryConsole.id, 'runFailed', 'page');
    void api.sendToConsole(queryConsole.id, { type: 'run', statements: statements('SELECT pg_sleep(30)'), autoCommit: true });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const started = Date.now();
    await api.sendToConsole(queryConsole.id, { type: 'stop' });
    const reply = await failed;
    assert.deepEqual([reply.type, (reply as Reply<'runFailed'>).message], ['runFailed', 'Query stopped.']);
    assert.ok(Date.now() - started < 10_000);
  });

  test('shows the definition of a function and refreshes a materialized view', async () => {
    const publicSchema = await child(await child(await root(), 'shop'), 'public');
    const total = await child(await child(publicSchema, 'Functions'), 'customer_total');
    await vscode.commands.executeCommand('datakit.showDefinition', total);
    assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', /^CREATE OR REPLACE FUNCTION public\.customer_total\(cid integer\)/);

    await sql("INSERT INTO public.customers (name, email) VALUES ('E2E Refresh', 'refresh@example.com')");
    try {
      const stats = await child(await child(publicSchema, 'Materialized views'), 'customer_stats');
      await stubbing('showInformationMessage', undefined, () => vscode.commands.executeCommand('datakit.refreshMaterializedView', stats));
      assert.deepEqual(await sql("SELECT orders FROM public.customer_stats WHERE name = 'E2E Refresh'"), [['0']]);
    } finally {
      await sql("DELETE FROM public.customers WHERE email = 'refresh@example.com'");
      await sql('REFRESH MATERIALIZED VIEW public.customer_stats');
    }
  });

  test('production data sources ask before refreshing a materialized view', async () => {
    const dataSource = api.store.get(dataSourceId)!;
    await api.store.save(dataSource.id, { ...dataSource, environment: 'production' }, {});
    try {
      let asked = '';
      const window = vscode.window as unknown as Record<string, unknown>;
      const original = window.showWarningMessage;
      window.showWarningMessage = async (message: string) => {
        asked = message;
        return undefined;
      };
      try {
        const stats = await child(await child(await child(await child(await root(), 'shop'), 'public'), 'Materialized views'), 'customer_stats');
        await vscode.commands.executeCommand('datakit.refreshMaterializedView', stats);
      } finally {
        window.showWarningMessage = original;
      }
      assert.equal(asked, 'Refresh materialized view public.customer_stats on “pg-shop” (Production)?');
    } finally {
      await api.store.save(dataSource.id, { ...dataSource, environment: 'development' }, {});
    }
  });
});
