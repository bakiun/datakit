import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataSourceSettings,
  type DataSourceSettings,
  type MongoCollectionHostMessage,
  type MongoCollectionWebviewMessage,
  type MongoEdit,
  type MongoFindQuery,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { CollectionRef } from '../../src/mongodb/mongoCollectionPanel';
import type { ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs MongoDB from docker/docker-compose.yml (port 37017, root / datakit, sample database `shop`).
// The tests write to their own database, which they drop at the end.

type Reply<T extends MongoCollectionHostMessage['type']> = Extract<MongoCollectionHostMessage, { type: T }>;

const DATABASE = `datakit_e2e_${Date.now().toString(36)}`;
const COLLECTION = 'people';

function mongoSettings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = { ...createDataSourceSettings('mongodb'), name: 'catalog', auth: 'password' as const, user: 'root', database: 'shop' };
  s.mongo.hosts = '127.0.0.1:37017';
  s.mongo.authSource = 'admin';
  patch(s);
  return s;
}

async function stubbing<T>(name: 'showSaveDialog' | 'showWarningMessage', value: unknown, run: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

suite('MongoDB collections', () => {
  let api: TestApi;
  let id: string;
  let ref: CollectionRef;

  const labelOf = (node: ExplorerNode) => {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  };
  const root = async () => (await listedDataSources(api)).find((n) => n.id === id)!;

  /** Sends a message as the page would and waits for the first reply of one of the given types. */
  async function send<T extends MongoCollectionHostMessage['type']>(message: MongoCollectionWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const reply = new Promise<Reply<T>>((resolve) => {
      const listener = api.onDidPostMongo((posted) => {
        if (posted.ref.collection !== ref.collection || posted.ref.database !== ref.database || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve(posted.message as Reply<T>);
      });
    });
    await api.sendToMongo(ref, message);
    return reply;
  }

  const edit = (e: MongoEdit) => send({ type: 'edit', edit: e }, 'written', 'writeFailed');
  const query = (patch: Partial<MongoFindQuery> = {}): MongoFindQuery => ({ filter: '', projection: '', sort: '', collation: '', skip: 0, limit: 20, ...patch });

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('bakiun.datakit')!.activate())!;
    id = (await api.store.save(null, mongoSettings(), { password: 'datakit' })).id;
    ref = { dataSourceId: id, database: DATABASE, collection: COLLECTION };
    const session = await api.sessions.connectMongo(id);
    await session.createCollection(DATABASE, COLLECTION);
    await session.write(DATABASE, COLLECTION, {
      kind: 'insert',
      text: '[{ name: "Ada", age: 36, city: "London" }, { name: "Linus", age: 28, city: "Helsinki" }, { name: "Grace", age: 45, city: "New York", tags: ["navy"] }]',
    });
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await (await api.sessions.connectMongo(id)).dropDatabase(DATABASE).catch(() => undefined);
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.store.delete(d.id);
    }
  });

  test('the tree lists the default database first, with its collections and views', async () => {
    const node = await root();
    const databases = await api.tree.getChildren(node);
    assert.equal(api.tree.getTreeItem(node).contextValue, 'dataSource.connected.mongodb');
    assert.match(String(api.tree.getTreeItem(node).description), /^mongodb 8\.\d+$/);
    assert.equal(labelOf(databases[0]!), 'shop');
    assert.equal(api.tree.getTreeItem(databases[0]!).description, 'default');
    const collections = await api.tree.getChildren(databases[0]);
    assert.deepEqual(collections.map(labelOf), ['customers', 'orders', 'paid_orders']);
    assert.equal(api.tree.getTreeItem(collections[1]!).description, '4');
    assert.equal(api.tree.getTreeItem(collections[2]!).contextValue, 'mongoView');
  });

  test('a double-click on a collection opens it', async () => {
    const database = (await api.tree.getChildren(await root())).find((n) => labelOf(n) === DATABASE)!;
    const people = (await api.tree.getChildren(database)).find((n) => labelOf(n) === COLLECTION)!;
    const command = api.tree.getTreeItem(people).command!;
    const init = new Promise<Reply<'init'>>((resolve) => {
      const listener = api.onDidPostMongo(({ message }) => message.type === 'init' && (listener.dispose(), resolve(message)));
    });
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const { init: started } = await init;
    assert.equal(started.type, 'collection');
    assert.equal(started.info.documents, 3);
    assert.match(started.serverLabel, /^MongoDB 8\./);
  });

  test('finds with a filter, sort and projection, and reports invalid filters', async () => {
    const all = await send({ type: 'find', requestId: 1, query: query({ sort: '{ age: 1 }' }) }, 'page');
    assert.equal(all.page.count, 3);
    const names = all.page.documents.map((d) => d.fields.find((f) => f.name === 'name')?.preview.replace(/^['"]|['"]$/g, ''));
    assert.deepEqual(names, ['Linus', 'Ada', 'Grace']);
    const older = await send({ type: 'find', requestId: 2, query: query({ filter: '{ age: { $gt: 30 } }', projection: '{ name: 1, _id: 0 }', sort: '{ name: 1 }' }) }, 'page');
    assert.equal(older.page.count, 2);
    assert.deepEqual(older.page.documents.map((d) => d.fields.map((f) => f.name)), [['name'], ['name']]);
    assert.equal(older.page.documents[0]!.id, null);
    const failed = await send({ type: 'find', requestId: 3, query: query({ filter: '{ age: ' }) }, 'page', 'pageFailed');
    assert.equal(failed.type, 'pageFailed');
  });

  test('writes edits and echoes their summaries', async () => {
    const inserted = await edit({ kind: 'insert', text: '{ name: "Margaret", age: 30 }' });
    assert.equal(inserted.type, 'written');
    const newId = inserted.type === 'written' ? inserted.result.insertedIds[0]! : '';
    assert.match(newId, /"\$oid"/);

    assert.equal((await edit({ kind: 'setField', id: newId, path: 'city', value: '"Boston"' })).type, 'written');
    const found = await send({ type: 'find', requestId: 4, query: query({ filter: '{ name: "Margaret" }' }) }, 'page');
    assert.equal(found.page.documents[0]!.fields.find((f) => f.name === 'city')?.type, 'String');

    const replaced = await edit({ kind: 'replace', id: newId, text: '{ name: "Margaret H.", age: 31 }' });
    assert.equal(replaced.type, 'written');
    const changedId = await edit({ kind: 'replace', id: newId, text: '{ _id: 5, name: "x" }' });
    assert.deepEqual([changedId.type, changedId.type === 'writeFailed' ? changedId.message : ''], ['writeFailed', 'The _id cannot be changed.']);

    const refused = await edit({ kind: 'deleteMatching', filter: '' });
    assert.equal(refused.type, 'writeFailed');
    const deleted = await stubbing('showWarningMessage', 'Apply', () => edit({ kind: 'delete', ids: [newId] }));
    assert.equal(deleted.type === 'written' && deleted.result.affected, 1);
  });

  test('creates, lists and drops an index, and samples the schema', async () => {
    assert.equal((await edit({ kind: 'createIndex', spec: { keys: '{ city: 1 }', name: '', unique: false, sparse: false, hidden: false, ttlSeconds: null, partialFilter: '' } })).type, 'written');
    const indexes = await send({ type: 'load', what: 'indexes' }, 'indexes');
    assert.deepEqual(indexes.indexes.map((i) => i.name).sort(), ['_id_', 'city_1']);
    assert.equal((await edit({ kind: 'dropIndex', name: 'city_1' })).type, 'written');
    assert.equal((await edit({ kind: 'dropIndex', name: '_id_' })).type, 'writeFailed');

    const schema = await send({ type: 'load', what: 'schema', sample: 100 }, 'schema');
    assert.equal(schema.schema.sampled, 3);
    assert.ok(schema.schema.fields.some((f) => f.path === 'tags[]'));
  });

  test('runs shell lines and refuses writes on a read-only data source', async () => {
    const count = await send({ type: 'shell', line: `db.${COLLECTION}.countDocuments({ age: { $lt: 40 } })` }, 'shell');
    assert.deepEqual([count.ok, count.output.trim()], [true, '2']);
    const dataSource = api.store.get(id)!;
    await api.store.save(id, { ...dataSource, options: { ...dataSource.options, readOnly: true } }, {});
    try {
      const refused = await send({ type: 'shell', line: `db.${COLLECTION}.deleteMany({})` }, 'shell');
      assert.deepEqual([refused.ok, refused.output], [false, 'The data source is read-only.']);
      assert.deepEqual(await edit({ kind: 'unsetField', id: '{"$oid":"000000000000000000000000"}', path: 'x' }), {
        type: 'writeFailed',
        kind: 'unsetField',
        message: 'The data source is read-only.',
      });
    } finally {
      await api.store.save(id, dataSource, {});
    }
    const unknown = await send({ type: 'shell', line: 'db.people.mapReduce()' }, 'shell');
    assert.equal(unknown.ok, false);
  });

  test('exports every matching document', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'datakit-mongo-')), 'people.jsonl');
    const saved = await stubbing('showSaveDialog', vscode.Uri.file(file), () => send({ type: 'export', query: { filter: '{}', projection: '', sort: '{ age: 1 }' }, format: 'jsonl' }, 'notice'));
    assert.equal(saved.message, 'Saved 3 documents to people.jsonl.');
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { name: string });
    assert.deepEqual(lines.map((l) => l.name), ['Linus', 'Ada', 'Grace']);
  });
});
