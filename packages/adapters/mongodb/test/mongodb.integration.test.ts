import { createDataSourceSettings, type DataSourceSettings, type MongoEdit, type MongoFindQuery } from '@datakit/core';
import { BSON, Double, Int32, Long, MongoClient, ObjectId, type Db } from 'mongodb';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMongoSession, testMongoConnection, type MongoClientSession } from '../src';

const USER = 'root';
const PASSWORD = 'mongo-secret';
const SSH_PASSWORD = 'ssh-secret';
const ORDERS = 30;

let network: StartedNetwork;
let mongo8: StartedTestContainer;
let replica: StartedTestContainer;
let sshd: StartedTestContainer;
let seedClient: MongoClient;
let shop: Db;
let session: MongoClientSession;
const orderIds: ObjectId[] = [];

const hostOf = (container: StartedTestContainer) => `${container.getHost()}:${container.getMappedPort(27017)}`;

function settings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mongodb');
  s.name = 'shop';
  s.mongo.hosts = hostOf(mongo8);
  s.auth = 'password';
  s.user = USER;
  patch(s);
  return s;
}

const query = (patch: Partial<MongoFindQuery> = {}): MongoFindQuery => ({ filter: '', projection: '', sort: '', collation: '', skip: 0, limit: 50, ...patch });
const edit = (e: MongoEdit, collection = 'orders') => session.write('shop', collection, e);

async function elapsed<T>(work: () => Promise<T>): Promise<number> {
  const started = performance.now();
  await work().catch(() => undefined);
  return performance.now() - started;
}

async function seed(): Promise<void> {
  shop = seedClient.db('shop');
  await shop.dropDatabase();
  const orders = Array.from({ length: ORDERS }, (_, i) => {
    const _id = new ObjectId();
    orderIds.push(_id);
    return {
      _id,
      n: new Int32(i),
      status: i % 3 === 0 ? 'void' : 'paid',
      total: new Double(i + 0.5),
      created: new Date(Date.UTC(2024, 0, 1 + i)),
      customer: { name: `c${i % 5}`, email: `c${i}@example.com` },
      items: [
        { sku: 'a', qty: 1 },
        { sku: 'b', qty: new Int32(2), note: i === 0 ? 'first' : null },
      ],
      tags: i % 2 ? ['x', 'y'] : [],
      big: Long.fromString('9007199254740993'),
    };
  });
  await shop.collection('orders').insertMany(orders);
  await shop.createCollection('log', { capped: true, size: 4096 });
  await shop.createCollection('paid', { viewOn: 'orders', pipeline: [{ $match: { status: 'paid' } }] });
  await shop.createCollection('weather', { timeseries: { timeField: 'ts', metaField: 'sensor' } });
  await shop.collection('weather').insertMany([
    { ts: new Date(), sensor: 's1', temp: 21.5 },
    { ts: new Date(), sensor: 's2', temp: 19 },
  ]);
}

beforeAll(async () => {
  network = await new Network().start();
  [mongo8, replica, sshd] = await Promise.all([
    new GenericContainer('mongo:8')
      .withNetwork(network)
      .withNetworkAliases('mongo')
      .withExposedPorts(27017)
      .withEnvironment({ MONGO_INITDB_ROOT_USERNAME: USER, MONGO_INITDB_ROOT_PASSWORD: PASSWORD })
      // The image starts a server to create the user, stops it and starts the real one.
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/, 2))
      .start(),
    new GenericContainer('mongo:7').withCommand(['--replSet', 'rs0', '--bind_ip_all']).withExposedPorts(27017).withWaitStrategy(Wait.forLogMessage(/Waiting for connections/)).start(),
    new GenericContainer('testcontainers/sshd:1.2.0').withNetwork(network).withExposedPorts(22).withEnvironment({ USERNAME: 'root', PASSWORD: SSH_PASSWORD }).start(),
  ]);
  seedClient = new MongoClient(`mongodb://${hostOf(mongo8)}/`, { auth: { username: USER, password: PASSWORD }, directConnection: true });
  await seedClient.connect();
  await seed();
  session = await openMongoSession(settings(), { password: PASSWORD });
});

afterAll(async () => {
  await session?.close();
  await seedClient?.close();
  await Promise.all([mongo8?.stop(), replica?.stop(), sshd?.stop()]);
  await network?.stop();
});

describe('connecting', () => {
  it('reads the version and topology of a standalone server', async () => {
    const result = await testMongoConnection(settings(), { password: PASSWORD });
    expect(result.serverVersion).toEqual({ product: 'MongoDB', version: expect.stringMatching(/^8\./) });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(session.kind).toBe('mongodb');
    expect(session.topology).toBe('Standalone');
  });

  it('fails fast and clearly on a wrong password, port or host', async () => {
    await expect(testMongoConnection(settings(), { password: 'wrong' })).rejects.toThrow('Authentication failed.');
    expect(await elapsed(() => testMongoConnection(settings(), { password: 'wrong' }))).toBeLessThan(5000);

    const wrongPort = settings((s) => (s.mongo.hosts = '127.0.0.1:1'));
    await expect(testMongoConnection(wrongPort, {})).rejects.toThrow('Connection refused (127.0.0.1:1).');
    expect(await elapsed(() => testMongoConnection(wrongPort, {}))).toBeLessThan(5000);

    const wrongHost = settings((s) => (s.mongo.hosts = 'no-such-host.invalid:27017'));
    await expect(testMongoConnection(wrongHost, {})).rejects.toThrow('Host not found (no-such-host.invalid:27017).');
  });

  it('logs in against the auth source and reports a close once', async () => {
    const wrongSource = settings((s) => (s.mongo.authSource = 'shop'));
    await expect(testMongoConnection(wrongSource, { password: PASSWORD })).rejects.toThrow('Authentication failed.');
    // The default database is the auth source unless one is given.
    await expect(testMongoConnection(settings((s) => (s.database = 'shop')), { password: PASSWORD })).rejects.toThrow('Authentication failed.');
    const other = await openMongoSession(
      settings((s) => {
        s.database = 'shop';
        s.mongo.authSource = 'admin';
      }),
      { password: PASSWORD },
    );
    const closes: (Error | undefined)[] = [];
    other.onDidClose((error) => closes.push(error));
    await other.close();
    await other.close();
    expect(closes).toEqual([undefined]);
  });

  it('reaches the server through an SSH tunnel', async () => {
    const tunneled = settings((s) => {
      s.mongo.hosts = 'mongo:27017';
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
    });
    const remote = await openMongoSession(tunneled, { password: PASSWORD, sshPassword: SSH_PASSWORD });
    expect((await remote.databases()).map((d) => d.name)).toContain('shop');
    await remote.close();
  });

  it('names a replica set', async () => {
    const s = createDataSourceSettings('mongodb');
    s.mongo.hosts = hostOf(replica);
    const first = await openMongoSession(s, {});
    expect(first.topology).toBe('Standalone');
    const line = 'db.adminCommand({ replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] } })';
    expect(first.planShell('admin', line).writes).toBe(true);
    expect(await first.shell('admin', line)).toMatchObject({ ok: true });
    for (let i = 0; i < 60; i++) {
      const hello = await first.shell('admin', 'db.runCommand({ hello: 1 })');
      if (hello.output.includes('isWritablePrimary: true')) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await first.close();
    const member = await openMongoSession(s, {});
    expect(member.serverVersion.version).toMatch(/^7\./);
    expect(member.topology).toBe('Replica set rs0');
    await member.close();
  });
});

describe('browsing', () => {
  it('lists databases and collections of every type', async () => {
    const databases = await session.databases();
    expect(databases.find((d) => d.name === 'shop')).toEqual({ name: 'shop', sizeOnDisk: expect.any(Number), empty: false });
    expect(databases.map((d) => d.name)).toContain('admin');

    const collections = await session.collections('shop');
    expect(collections.map((c) => c.name)).toEqual(['log', 'orders', 'paid', 'weather']);
    expect(collections.find((c) => c.name === 'orders')).toEqual({ name: 'orders', type: 'collection', documents: ORDERS, bytes: null, capped: false, viewOn: null, pipeline: null });
    expect(collections.find((c) => c.name === 'log')).toMatchObject({ type: 'collection', capped: true, documents: 0 });
    expect(collections.find((c) => c.name === 'paid')).toEqual({
      name: 'paid',
      type: 'view',
      documents: null,
      bytes: null,
      capped: false,
      viewOn: 'orders',
      pipeline: "[\n  {\n    $match: {\n      status: 'paid'\n    }\n  }\n]",
    });
    expect(collections.find((c) => c.name === 'weather')).toMatchObject({ type: 'timeseries', documents: 2 });

    expect(await session.collection('shop', 'orders')).toMatchObject({ documents: ORDERS, bytes: expect.any(Number) });
    expect((await session.collection('shop', 'orders'))!.bytes).toBeGreaterThan(0);
    expect(await session.collection('shop', 'paid')).toMatchObject({ type: 'view', bytes: null, documents: null });
    expect(await session.collection('shop', 'nope')).toBeNull();
  });

  it('finds with ObjectId, ISODate and regex filters, projection, sort, skip and limit', async () => {
    const byId = await session.find('shop', 'orders', query({ filter: `{ _id: ObjectId("${orderIds[3]!.toHexString()}") }` }));
    expect(byId.count).toBe(1);
    const [doc] = byId.documents;
    expect(doc!.id).toBe(BSON.EJSON.stringify(orderIds[3], { relaxed: false }));
    expect(doc!.idText).toBe(`ObjectId('${orderIds[3]!.toHexString()}')`);
    expect(doc!.truncated).toBe(false);
    expect(doc!.size).toBeGreaterThan(100);
    expect(doc!.text).toContain("  created: ISODate('2024-01-04T00:00:00.000Z'),\n");
    expect(Object.fromEntries(doc!.fields.map((f) => [f.name, [f.type, f.preview]]))).toMatchObject({
      _id: ['ObjectId', `ObjectId('${orderIds[3]!.toHexString()}')`],
      n: ['Int32', '3'],
      total: ['Double', '3.5'],
      created: ['Date', "ISODate('2024-01-04T00:00:00.000Z')"],
      customer: ['Object', "{ name: 'c3', email: 'c3@example.com' }"],
      items: ['Array', "[ { sku: 'a', qty: 1 }, { sku: 'b', qty: 2, note: null } ]"],
      big: ['Int64', "NumberLong('9007199254740993')"],
    });

    const recent = await session.find('shop', 'orders', query({ filter: '{ created: { $gte: ISODate("2024-01-21") } }' }));
    expect(recent.count).toBe(10);
    const regex = await session.find('shop', 'orders', query({ filter: '{ "customer.name": /^c1$/ }' }));
    expect(regex.count).toBe(6);

    const page = await session.find('shop', 'orders', query({ projection: '{ n: 1, _id: 0 }', sort: '{ n: -1 }', skip: 2, limit: 3 }));
    expect(page.count).toBe(ORDERS);
    expect(page.documents.map((d) => d.text)).toEqual(['{\n  n: 27\n}', '{\n  n: 26\n}', '{\n  n: 25\n}']);
    expect(page.documents[0]).toMatchObject({ id: null, idText: null, fields: [{ name: 'n', type: 'Int32', preview: '27', complete: true }] });

    const collated = await session.find('shop', 'orders', query({ filter: '{ status: "PAID" }', collation: '{ locale: "en", strength: 2 }' }));
    expect(collated.count).toBe(20);
  });

  it('names the part of the query that does not parse', async () => {
    await expect(session.find('shop', 'orders', query({ filter: '{ status: }' }))).rejects.toThrow(/^Filter: Unexpected token/);
    await expect(session.find('shop', 'orders', query({ projection: '{ n: 1' }))).rejects.toThrow(/^Projection: /);
    await expect(session.find('shop', 'orders', query({ sort: '5' }))).rejects.toThrow('Sort: Give a document');
    await expect(session.find('shop', 'orders', query({ filter: '{ n: someVariable }' }))).rejects.toThrow(/^Filter: Only values can be used here/);
    await expect(session.find('shop', 'orders', query({ filter: '{ _id: ObjectId("nope") }' }))).rejects.toThrow(/^Filter: .*24 character hex string/);
  });

  it('aggregates, limits and refuses pipelines that write', async () => {
    const page = await session.aggregate('shop', 'orders', '[{ $match: { status: "void" } }, { $group: { _id: "$status", n: { $sum: 1 } } }]', 10);
    expect(page.count).toBeNull();
    expect(page.documents.map((d) => d.text)).toEqual(["{\n  _id: 'void',\n  n: 10\n}"]);
    expect(page.documents[0]!.id).toBe('"void"');
    expect((await session.aggregate('shop', 'orders', '', 4)).documents).toHaveLength(4);
    expect((await session.aggregate('shop', 'orders', '[{ $project: { _id: 0, n: 1 } }]', 2)).documents[0]!.id).toBeNull();
    await expect(session.aggregate('shop', 'orders', '[{ $out: "copy" }]', 10)).rejects.toThrow('Pipelines with $out or $merge write data; run them in the shell.');
    await expect(session.aggregate('shop', 'orders', '{ $match: {} }', 10)).rejects.toThrow(/^Pipeline: Give an array of stages/);
  });

  it('explains a collection scan and an index scan', async () => {
    const scan = await session.explain('shop', 'orders', query({ filter: '{ n: 5 }' }));
    expect(scan).toMatchObject({ index: null, returned: 1, docsExamined: ORDERS, keysExamined: 0 });
    expect(scan.stages).toContain('COLLSCAN');
    expect(scan.text).toContain('queryPlanner');

    await edit({ kind: 'createIndex', spec: { keys: '{ n: 1 }', name: '', unique: false, sparse: false, hidden: false, ttlSeconds: null, partialFilter: '' } });
    const seek = await session.explain('shop', 'orders', query({ filter: '{ n: { $gte: 25 } }', limit: 0 }));
    expect(seek).toMatchObject({ index: 'n_1', returned: 5, docsExamined: 5, keysExamined: 5 });
    expect(seek.stages).toEqual(['FETCH', 'IXSCAN']);

    const grouped = await session.explain('shop', 'orders', { pipeline: '[{ $match: { n: { $gte: 25 } } }, { $group: { _id: "$status", c: { $sum: 1 } } }]' });
    expect(grouped.index).toBe('n_1');
    expect(grouped.stages).toContain('IXSCAN');
    await edit({ kind: 'dropIndex', name: 'n_1' });
  });

  it('reads one document by its id', async () => {
    const found = await session.find('shop', 'orders', query({ limit: 1, sort: '{ n: 1 }' }));
    const id = found.documents[0]!.id!;
    expect((await session.document('shop', 'orders', id))!.text).toBe(found.documents[0]!.text);
    expect(await session.document('shop', 'orders', BSON.EJSON.stringify(new ObjectId(), { relaxed: false }))).toBeNull();
  });

  it('cuts the text of documents over 1 MiB and long previews', async () => {
    await seedClient.db('shop').collection<{ _id: number; blob: string; small: string }>('large').insertOne({ _id: 1, blob: 'x'.repeat(1100 * 1024), small: 'y' });
    const [large] = (await session.find('shop', 'large', query())).documents;
    expect(large).toMatchObject({ id: '{"$numberInt":"1"}', truncated: true, size: expect.any(Number) });
    expect(large!.size).toBeGreaterThan(1024 * 1024);
    expect(large!.text).toHaveLength(64 * 1024);
    expect(large!.fields[1]).toMatchObject({ name: 'blob', type: 'String', complete: false });
    expect(large!.fields[1]!.preview).toHaveLength(200);
    expect(large!.fields[2]).toEqual({ name: 'small', type: 'String', preview: "'y'", complete: true });
    await seedClient.db('shop').collection('large').drop();
  });

  it('samples the schema with nested fields and array elements', async () => {
    const schema = await session.schema('shop', 'orders', 100);
    expect(schema.sampled).toBe(ORDERS);
    const field = (path: string) => schema.fields.find((f) => f.path === path);
    expect(schema.fields.map((f) => f.path).slice(0, 4)).toEqual(['_id', 'n', 'status', 'total']);
    expect(field('customer.name')).toMatchObject({ count: ORDERS, types: [{ type: 'String', count: ORDERS }] });
    expect(field('customer.name')!.examples).toHaveLength(3);
    expect(field('items[]')).toMatchObject({ count: ORDERS, types: [{ type: 'Object', count: ORDERS }] });
    expect(field('items[].qty')).toMatchObject({ count: ORDERS, types: [{ type: 'Int32', count: ORDERS }] });
    expect(field('items[].note')!.types).toEqual([
      { type: 'Null', count: ORDERS - 1 },
      { type: 'String', count: 1 },
    ]);
    expect(field('tags')).toMatchObject({ count: ORDERS, types: [{ type: 'Array', count: ORDERS }] });
    expect(field('tags[]')).toMatchObject({ count: ORDERS / 2, examples: ["'x'", "'y'"] });
    expect(field('big')!.types).toEqual([{ type: 'Int64', count: ORDERS }]);
  });
});

describe('editing', () => {
  it('inserts, replaces, sets and unsets fields and keeps BSON types', async () => {
    const one = await edit({ kind: 'insert', text: '{ sku: "k1", d: Double(5), i: 5, l: NumberLong(7), u: UUID("0e1f2c3d-4b5a-4697-8a9b-0c1d2e3f4a5b") }' }, 'items');
    expect(one).toMatchObject({ summary: 'Inserted 1 document', affected: 1, insertedIds: [expect.stringContaining('$oid')] });
    const many = await edit({ kind: 'insert', text: '[{ _id: 1, sku: "k2" }, { _id: "x", sku: "k3" }]' }, 'items');
    expect(many).toEqual({ summary: 'Inserted 2 documents', affected: 2, insertedIds: ['{"$numberInt":"1"}', '"x"'] });

    const id = one.insertedIds[0]!;
    const doc = (await session.document('shop', 'items', id))!;
    expect(doc.text).toContain("  d: Double('5'),\n  i: 5,\n  l: NumberLong('7'),\n  u: UUID('0e1f2c3d-4b5a-4697-8a9b-0c1d2e3f4a5b')");
    expect(doc.fields.map((f) => f.type)).toEqual(['ObjectId', 'String', 'Double', 'Int32', 'Int64', 'UUID']);

    // The text the editor shows saves back to the same types.
    expect(await edit({ kind: 'replace', id, text: doc.text.replace("sku: 'k1'", "sku: 'k1b'") }, 'items')).toEqual({ summary: 'Updated 1 document', affected: 1, insertedIds: [] });
    const replaced = (await session.document('shop', 'items', id))!;
    expect(replaced.fields.map((f) => f.type)).toEqual(['ObjectId', 'String', 'Double', 'Int32', 'Int64', 'UUID']);
    expect(replaced.fields[1]!.preview).toBe("'k1b'");
    await expect(edit({ kind: 'replace', id, text: `{ _id: ObjectId("${new ObjectId().toHexString()}"), sku: "k1" }` }, 'items')).rejects.toThrow('The _id cannot be changed.');
    await edit({ kind: 'replace', id: '{"$numberInt":"1"}', text: '{ sku: "k2b" }' }, 'items');
    expect((await session.document('shop', 'items', '{"$numberInt":"1"}'))!.text).toBe("{\n  _id: 1,\n  sku: 'k2b'\n}");

    await edit({ kind: 'setField', id, path: 'meta.seen', value: 'ISODate("2024-05-01T10:00:00Z")' }, 'items');
    await edit({ kind: 'unsetField', id, path: 'u' }, 'items');
    const changed = (await session.document('shop', 'items', id))!;
    expect(changed.fields.find((f) => f.name === 'meta')).toMatchObject({ type: 'Object', preview: "{ seen: ISODate('2024-05-01T10:00:00.000Z') }" });
    expect(changed.fields.find((f) => f.name === 'u')).toBeUndefined();
    await expect(edit({ kind: 'setField', id: BSON.EJSON.stringify(new ObjectId(), { relaxed: false }), path: 'a', value: '1' }, 'items')).rejects.toThrow(/not found/);
    await expect(edit({ kind: 'setField', id, path: 'a', value: '{ a: ' }, 'items')).rejects.toThrow(/^Value: /);
  });

  it('deletes and updates by id and by filter, and refuses an empty filter', async () => {
    const ids = (await session.find('shop', 'items', query())).documents.map((d) => d.id!);
    expect(await edit({ kind: 'delete', ids: ids.slice(0, 2) }, 'items')).toMatchObject({ summary: 'Deleted 2 documents', affected: 2 });
    await expect(edit({ kind: 'deleteMatching', filter: '' }, 'items')).rejects.toThrow('Give a filter; use the shell to delete every document.');
    await expect(edit({ kind: 'deleteMatching', filter: '{}' }, 'items')).rejects.toThrow('Give a filter; use the shell to delete every document.');

    await edit({ kind: 'insert', text: '[{ k: 1, s: "a" }, { k: 2, s: "a" }, { k: 3, s: "b" }]' }, 'more');
    expect(await edit({ kind: 'updateMatching', filter: '{ s: "a" }', update: '{ $inc: { k: 10 } }' }, 'more')).toMatchObject({ summary: 'Updated 2 documents', affected: 2 });
    expect(await edit({ kind: 'updateMatching', filter: '', update: '[{ $set: { t: { $concat: ["$s", "!"] } } }]' }, 'more')).toMatchObject({ affected: 3 });
    await expect(edit({ kind: 'updateMatching', filter: '', update: '{ k: 1 }' }, 'more')).rejects.toThrow(/atomic operators/);
    expect(await edit({ kind: 'deleteMatching', filter: '{ k: { $gt: 10 } }' }, 'more')).toEqual({ summary: 'Deleted 2 documents', affected: 2, insertedIds: [] });
    const left = await session.find('shop', 'more', query({ projection: '{ _id: 0 }' }));
    expect(left.documents.map((d) => d.text)).toEqual(["{\n  k: 3,\n  s: 'b',\n  t: 'b!'\n}"]);
  });

  it('creates, hides and drops indexes and lists their usage', async () => {
    const spec = { name: '', unique: false, sparse: false, hidden: false, ttlSeconds: null, partialFilter: '' };
    expect(await edit({ kind: 'createIndex', spec: { ...spec, keys: '{ "customer.email": 1 }', unique: true } })).toEqual({ summary: 'Created index customer.email_1', affected: 1, insertedIds: [] });
    await edit({ kind: 'createIndex', spec: { ...spec, keys: '{ created: 1 }', name: 'expiry', ttlSeconds: 3600 * 24 * 365 } });
    await edit({ kind: 'createIndex', spec: { ...spec, keys: '{ status: 1, n: -1 }', partialFilter: '{ status: "paid" }', sparse: false } });
    await session.find('shop', 'orders', query({ filter: '{ "customer.email": "c1@example.com" }' }));

    await edit({ kind: 'hideIndex', name: 'expiry', hidden: true });
    const indexes = await session.indexes('shop', 'orders');
    expect(indexes.map((i) => i.name)).toEqual(['_id_', 'customer.email_1', 'expiry', 'status_1_n_-1']);
    expect(indexes[1]).toMatchObject({ keys: "{ 'customer.email': 1 }", unique: true, hidden: false, ttlSeconds: null, bytes: expect.any(Number), ops: expect.any(Number), usageSince: expect.any(Number) });
    expect(indexes[1]!.ops).toBeGreaterThanOrEqual(1);
    expect(indexes[2]).toMatchObject({ keys: '{ created: 1 }', hidden: true, ttlSeconds: 3600 * 24 * 365 });
    expect(indexes[3]).toMatchObject({ keys: '{ status: 1, n: -1 }', partialFilter: "{ status: 'paid' }" });
    expect(await session.indexes('shop', 'paid')).toEqual([]);

    await expect(edit({ kind: 'dropIndex', name: '_id_' })).rejects.toThrow('The _id index cannot be dropped.');
    expect(await edit({ kind: 'dropIndex', name: 'expiry' })).toMatchObject({ summary: 'Dropped index expiry', affected: 1 });
    await expect(edit({ kind: 'createIndex', spec: { ...spec, keys: '{ status: 1 }', unique: true } })).rejects.toThrow(/E11000/);
  });

  it('creates, renames and drops collections and databases', async () => {
    await session.createCollection('scratch', 'one');
    await session.renameCollection('scratch', 'one', 'two');
    expect((await session.collections('scratch')).map((c) => c.name)).toEqual(['two']);
    await session.dropCollection('scratch', 'two');
    expect(await session.collections('scratch')).toEqual([]);
    await session.createCollection('scratch', 'three');
    await session.dropDatabase('scratch');
    expect((await session.databases()).map((d) => d.name)).not.toContain('scratch');
  });

  it('exports in batches of relaxed Extended JSON and stops when asked', async () => {
    await seedClient
      .db('shop')
      .collection('bulk')
      .insertMany(Array.from({ length: 2500 }, (_, i) => ({ i, at: new Date(0) })));
    const sizes: number[] = [];
    const all = await session.exportDocuments('shop', 'bulk', { filter: '', projection: '', sort: '{ i: 1 }' }, (batch) => {
      sizes.push(batch.length);
      if (sizes.length === 1) expect(batch[0]).toEqual({ _id: { $oid: expect.any(String) }, i: 0, at: { $date: '1970-01-01T00:00:00Z' } });
      return true;
    });
    expect(all).toBe(2500);
    expect(sizes).toEqual([1000, 1000, 500]);
    const stopped = await session.exportDocuments('shop', 'bulk', { filter: '{ i: { $gte: 100 } }', projection: '{ _id: 0 }', sort: '' }, () => false);
    expect(stopped).toBe(1000);
  });
});

describe('shell', () => {
  const run = (line: string, database = 'shop') => session.shell(database, line);

  it('plans reads and writes and refuses what it does not support', () => {
    const plan = (line: string) => session.planShell('shop', line);
    expect(plan('db.orders.find({ status: "paid" }).sort({ n: 1 }).limit(2);')).toEqual({ writes: false, description: 'db.orders.find({ status: "paid" }).sort({ n: 1 }).limit(2)' });
    expect(plan('show dbs').writes).toBe(false);
    expect(plan('use other').writes).toBe(false);
    expect(plan('db.orders.deleteMany({ status: "void" })')).toEqual({ writes: true, description: 'db.orders.deleteMany({ status: "void" })' });
    expect(plan('db.getCollection("orders").insertOne({ a: 1 })').writes).toBe(true);
    expect(plan('db.orders.aggregate([{ $match: {} }])').writes).toBe(false);
    expect(plan('db.orders.aggregate([{ $match: {} }, { $out: "copy" }])').writes).toBe(true);
    expect(plan('db.runCommand({ ping: 1 })').writes).toBe(false);
    expect(plan('db.runCommand("buildInfo")').writes).toBe(false);
    expect(plan('db.runCommand({ aggregate: "orders", pipeline: [{ $merge: "x" }], cursor: {} })').writes).toBe(true);
    expect(plan('db.adminCommand({ listDatabases: 1 })').writes).toBe(false);
    expect(plan('db.runCommand({ drop: "orders" })').writes).toBe(true);
    expect(plan('db.createCollection("x")').writes).toBe(true);
    expect(plan('db["orders"].countDocuments()').writes).toBe(false);

    expect(() => plan('db.orders.mapReduce()')).toThrow('Not supported in this shell: db.orders.mapReduce()');
    expect(() => plan('rs.status()')).toThrow('Not supported in this shell: rs');
    expect(() => plan('db.version()')).toThrow('Not supported in this shell: db.version()');
    expect(() => plan('db.orders.find().hint({ n: 1 })')).toThrow('Not supported in this shell: .hint() after find()');
    expect(() => plan('show users')).toThrow('Not supported in this shell: show users');
    expect(() => plan('db.orders.find(); db.orders.drop()')).toThrow(/^Not supported in this shell/);
    expect(() => plan('db.orders.find({ a: ')).toThrow(/^SyntaxError: Unexpected token/);
    expect(() => plan('db.orders.find({ a: process.exit() })')).toThrow(/^Argument 1 of find\(\): Only values/);
  });

  it('switches databases and lists databases and collections', async () => {
    expect((await run('show dbs')).output).toMatch(/^admin +\d+\.\d\d KiB$/m);
    expect((await run('show collections')).output).toBe('bulk\nitems\nlog\nmore\norders\npaid\nweather');
    expect(await run('use other')).toEqual({ output: 'switched to db other', ok: true, database: 'other' });
    expect(await run('db', 'other')).toEqual({ output: 'other', ok: true, database: 'other' });
    expect((await run('db.getName()')).output).toBe('shop');
    expect((await run('db.getCollectionNames()')).output).toBe("[\n  'bulk',\n  'items',\n  'log',\n  'more',\n  'orders',\n  'paid',\n  'system.buckets.weather',\n  'system.views',\n  'weather'\n]");
    expect((await run('db.stats()')).output).toContain("db: 'shop'");
    expect((await run('db.runCommand({ ping: 1 })')).output).toBe('{ ok: 1 }');
    expect((await run('db.adminCommand("listDatabases")')).output).toContain("name: 'shop'");
  });

  it('prints finds like mongosh, at most 20 documents unless limited', async () => {
    const all = await run('db.orders.find({}, { _id: 0, n: 1 }).sort({ n: 1 })');
    expect(all.ok).toBe(true);
    expect(all.output.startsWith('[\n  { n: 0 },\n  { n: 1 },\n')).toBe(true);
    expect(all.output.endsWith('  { n: 19 }\n]\n… 10 more (add .limit() or use the Documents tab)')).toBe(true);
    expect((await run('db.orders.find({}, { _id: 0, n: 1 }).sort({ n: -1 }).skip(1).limit(2)')).output).toBe('[\n  { n: 28 },\n  { n: 27 }\n]');
    expect((await run('db.orders.find({ n: { $gte: 0 } }, { _id: 0, n: 1 }).limit(25).toArray()')).output.split('\n')).toHaveLength(27);
    expect((await run('db.orders.find({ status: "void" }).count()')).output).toBe('10');
    expect((await run('db.orders.find({ n: 99 })')).output).toBe('[]');
    expect((await run('db.orders.find({ n: 1 }).explain()')).output).toContain('queryPlanner');
    expect((await run('db.orders.findOne({ n: 2 }, { _id: 0, n: 1, total: 1 })')).output).toBe('{ n: 2, total: 2.5 }');
    expect((await run('db.orders.countDocuments({ status: "paid" })')).output).toBe('20');
    expect((await run('db.orders.estimatedDocumentCount()')).output).toBe('30');
    expect((await run('db.orders.distinct("status")')).output).toBe("[ 'paid', 'void' ]");
    expect((await run('db.orders.aggregate([{ $group: { _id: "$status", c: { $sum: 1 } } }, { $sort: { _id: 1 } }])')).output).toBe("[\n  { _id: 'paid', c: 20 },\n  { _id: 'void', c: 10 }\n]");
    expect((await run('db.orders.aggregate({ $match: { n: 1 } }, { $project: { _id: 0, n: 1 } })')).output).toBe('[\n  { n: 1 }\n]');
    expect((await run('db.system.profile.find()')).output).toBe('[]');
  });

  it('writes and prints results like mongosh', async () => {
    const inserted = await run('db.shell.insertOne({ _id: 1, name: "Ada", at: ISODate("2024-01-01") })');
    expect(inserted).toEqual({ output: '{ acknowledged: true, insertedId: 1 }', ok: true, database: 'shop' });
    expect((await run('db.shell.insertOne({ name: "Bob" })')).output).toMatch(/^{ acknowledged: true, insertedId: ObjectId\('[0-9a-f]{24}'\) }$/);
    expect((await run('db.shell.insertMany([{ _id: 2 }, { _id: 3 }])')).output).toBe("{ acknowledged: true, insertedIds: { '0': 2, '1': 3 } }");
    expect((await run('db.shell.updateOne({ _id: 1 }, { $set: { name: "Ada L." } })')).output).toBe(
      '{\n  acknowledged: true,\n  insertedId: null,\n  matchedCount: 1,\n  modifiedCount: 1,\n  upsertedCount: 0\n}',
    );
    expect((await run('db.shell.updateMany({ _id: { $gt: 1 } }, { $set: { n: 1 } })')).output).toContain('matchedCount: 2');
    expect((await run('db.shell.replaceOne({ _id: 2 }, { n: 2 })')).output).toContain('modifiedCount: 1');
    expect((await run('db.shell.findOneAndUpdate({ _id: 3 }, { $inc: { n: 1 } }, { returnDocument: "after" })')).output).toBe('{ _id: 3, n: 2 }');
    expect((await run('db.shell.findOneAndReplace({ _id: 3 }, { n: 5 })')).output).toBe('{ _id: 3, n: 2 }');
    expect((await run('db.shell.findOneAndDelete({ _id: 3 })')).output).toBe('{ _id: 3, n: 5 }');
    expect((await run('db.shell.deleteOne({ _id: 2 })')).output).toBe('{ acknowledged: true, deletedCount: 1 }');
    expect((await run('db.shell.createIndex({ name: 1 }, { unique: true })')).output).toBe('name_1');
    expect((await run('db.shell.getIndexes()')).output).toContain("name: 'name_1'");
    expect((await run('db.shell.dropIndex("name_1")')).output).toContain('nIndexesWas: 2');
    expect((await run('db.shell.dropIndexes()')).output).toContain('nIndexesWas: 1');
    expect((await run('db.shell.stats()')).output).toContain("ns: 'shop.shell'");
    expect((await run('db.shell.renameCollection("shell2")')).output).toBe('{ ok: 1 }');
    expect((await run('db.getCollection("shell2").deleteMany({})')).output).toBe('{ acknowledged: true, deletedCount: 2 }');
    expect((await run('db["shell2"].drop()')).output).toBe('true');
    expect((await run('db.createCollection("made", { capped: true, size: 4096 })', 'other')).output).toBe('{ ok: 1 }');
    expect((await run('db.dropDatabase()', 'other')).output).toBe("{ ok: 1, dropped: 'other' }");
    expect((await run('db.orders.aggregate([{ $match: { status: "void" } }, { $out: "voided" }])')).output).toBe('[]');
    expect((await run('db.voided.countDocuments()')).output).toBe('10');
  });

  it('returns errors as output', async () => {
    await run('db.dupes.insertOne({ _id: 1 })');
    const duplicate = await run('db.dupes.insertOne({ _id: 1 })');
    expect(duplicate.ok).toBe(false);
    expect(duplicate.output).toMatch(/^MongoServerError: E11000 duplicate key error/);
    expect(await run('db.runCommand({ nope: 1 })')).toMatchObject({ ok: false, output: expect.stringMatching(/^MongoServerError: no such command: 'nope'/) });
    expect(await run('db.orders.mapReduce()')).toMatchObject({ ok: false, output: 'Not supported in this shell: db.orders.mapReduce()' });
    expect(await run('use bad.name')).toMatchObject({ ok: false, database: 'shop' });
  });
});
