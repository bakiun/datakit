import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDataSourceSettings, type DataSourceSettings, type RedisKeysHostMessage, type RedisKeysWebviewMessage } from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs the Redis server from docker/docker-compose.yml (port 36379). Database 1 is flushed and filled.

type Reply<T extends RedisKeysHostMessage['type']> = Extract<RedisKeysHostMessage, { type: T }>;

async function stubbing<T>(name: 'showWarningMessage' | 'showSaveDialog', value: unknown, run: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

function redisSettings(patch: Partial<DataSourceSettings> = {}): DataSourceSettings {
  return { ...createDataSourceSettings('redis'), name: 'cache', host: '127.0.0.1', port: '36379', database: '1', ...patch };
}

suite('Redis key browser', () => {
  let api: TestApi;
  let id: string;

  const labelOf = (node: ExplorerNode) => {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  };
  const root = async () => (await listedDataSources(api)).find((n) => n.id === id)!;

  /** Sends a message as the page would and waits for the first reply of one of the given types. */
  async function send<T extends RedisKeysHostMessage['type']>(message: RedisKeysWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const reply = new Promise<Reply<T>>((resolve) => {
      const listener = api.onDidPostRedis((posted) => {
        if (posted.dataSourceId !== id || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve(posted.message as Reply<T>);
      });
    });
    await api.sendToRedis(id, message);
    return reply;
  }

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('bakiun.datakit')!.activate())!;
    id = (await api.store.save(null, redisSettings(), { password: 'datakit' })).id;
    const session = await api.sessions.connectRedis(id);
    for (const command of [
      ['FLUSHDB'],
      ['SET', 'user:1', '{"id":1,"name":"Daniel"}'],
      ['HSET', 'session:1', 'user', '1', 'cart', '[1,2]'],
      ['RPUSH', 'queue:emails', 'a', 'b', 'c'],
      ['ZADD', 'leaderboard', '10', 'u1', '20', 'u2'],
      ['EXPIRE', 'session:1', '600'],
    ]) {
      await session.command(command);
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.store.delete(d.id);
    }
  });

  test('the tree lists the databases that hold keys, with their counts', async () => {
    await api.sessions.disconnect(id);
    const node = await root();
    const databases = await api.tree.getChildren(node);
    assert.equal(api.tree.getTreeItem(node).contextValue, 'dataSource.connected.redis');
    assert.match(String(api.tree.getTreeItem(node).description), /^redis 8\.0$/);
    const db1 = databases.find((d) => labelOf(d) === 'db1');
    assert.ok(db1, 'db1 is listed');
    assert.equal(api.tree.getTreeItem(db1).description, '4 keys');
  });

  test('a double-click on a database opens the key browser, which scans and opens keys', async () => {
    const db1 = (await api.tree.getChildren(await root())).find((d) => labelOf(d) === 'db1')!;
    const command = api.tree.getTreeItem(db1).command!;
    const next = <T extends RedisKeysHostMessage['type']>(type: T) =>
      new Promise<Reply<T>>((resolve) => {
        const listener = api.onDidPostRedis(({ message }) => message.type === type && (listener.dispose(), resolve(message as Reply<T>)));
      });
    // The page scans and opens the first key by itself once it has started; the test waits for that to finish.
    const init = next('init');
    const firstScan = next('keys');
    const firstKey = next('key');
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const { init: started } = await init;
    await firstScan;
    await firstKey;
    assert.equal(started.database, 1);
    assert.equal(started.fieldTtl, true);
    assert.equal(started.keepTtl, true);
    assert.equal(started.scanCount, 500);
    assert.equal(started.lastScan, null);
    assert.match(started.serverLabel, /^Redis 8\.0/);

    const keys = await send({ type: 'scan', match: '*', keyType: null, cursor: '0', count: null, append: false }, 'keys');
    assert.equal(keys.total, 4);
    assert.deepEqual(keys.keys.map((k) => k.key).sort(), ['leaderboard', 'queue:emails', 'session:1', 'user:1']);
    const hashes = await send({ type: 'scan', match: 's*', keyType: 'hash', cursor: '0', count: 10, append: false }, 'keys');
    assert.deepEqual(hashes.keys, [{ key: 'session:1', type: 'hash', ttl: hashes.keys[0]!.ttl }]);
    // The browser opens on the pattern and type used last time.
    const reopened = await send({ type: 'ready' }, 'init');
    assert.deepEqual(reopened.init.lastScan, { cursor: '0', match: 's*', type: 'hash', count: 10 });

    const opened = await send({ type: 'open', key: 'session:1' }, 'key');
    assert.equal(opened.detail.type, 'hash');
    assert.ok(opened.detail.ttl! > 500);
    assert.equal(opened.page.type, 'hash');
  });

  test('edits are written at once and echoed as Redis commands', async () => {
    const written = send({ type: 'edit', edit: { kind: 'hashSet', key: 'session:1', field: 'user', value: '2' } }, 'written');
    const reloaded = new Promise<Reply<'key'>>((resolve) => {
      const listener = api.onDidPostRedis(({ message }) => message.type === 'key' && (listener.dispose(), resolve(message)));
    });
    assert.deepEqual((await written).commands, ['HSET session:1 user 2']);
    const { page } = await reloaded;
    assert.ok(page.type === 'hash' && page.rows.some((r) => r.field === 'user' && r.value === '2'));

    // A list element that changed since it was loaded is not overwritten; the page reads the list again.
    const list = await send({ type: 'edit', edit: { kind: 'listSet', key: 'queue:emails', index: 0, value: 'z', expected: 'stale' } }, 'written', 'writeFailed');
    assert.deepEqual(list, { type: 'writeFailed', message: 'The list changed since it was loaded, so nothing was written.', reason: 'stale' });

    const renamed = await send({ type: 'edit', edit: { kind: 'renameKey', key: 'user:1', to: 'user:42' } }, 'written');
    assert.equal(renamed.key, 'user:42');
    await send({ type: 'edit', edit: { kind: 'expire', key: 'user:42', ttl: 120 } }, 'written');
    assert.ok(((await send({ type: 'open', key: 'user:42' }, 'key')).detail.ttl ?? 0) > 100);

    const declined = await stubbing('showWarningMessage', undefined, () =>
      send({ type: 'edit', edit: { kind: 'deleteKeys', keys: ['leaderboard'] } }, 'written', 'writeFailed'),
    );
    assert.deepEqual(declined, { type: 'writeFailed', message: 'Nothing was written.', reason: 'cancelled' });
    const deleted = await stubbing('showWarningMessage', 'Delete', () => send({ type: 'edit', edit: { kind: 'deleteKeys', keys: ['leaderboard'] } }, 'written'));
    assert.equal(deleted.key, null);
    assert.equal((await send({ type: 'open', key: 'leaderboard' }, 'keyGone', 'key')).type, 'keyGone');
  });

  test('the CLI answers like redis-cli and follows SELECT', async () => {
    const get = await send({ type: 'cli', line: 'HGET session:1 cart' }, 'cli');
    assert.deepEqual(get, { type: 'cli', line: 'HGET session:1 cart', output: '"[1,2]"', ok: true, durationMs: get.durationMs, wrote: false });
    const range = await send({ type: 'cli', line: "LRANGE queue:emails 0 -1" }, 'cli');
    assert.equal(range.output, '1) "a"\n2) "b"\n3) "c"');
    const set = await send({ type: 'cli', line: 'SET greeting "hello world"' }, 'cli');
    assert.equal(set.wrote, true);
    assert.equal((await send({ type: 'cli', line: 'GET greeting' }, 'cli')).output, '"hello world"');

    const switched = send({ type: 'cli', line: 'SELECT 2' }, 'database');
    await api.sendToRedis(id, { type: 'cli', line: 'SELECT 2' });
    assert.equal((await switched).database, 2);
    assert.equal((await send({ type: 'select', database: 1 }, 'database')).database, 1);
  });

  test('a read-only data source refuses edits and writing commands', async () => {
    const dataSource = api.store.get(id)!;
    await api.store.save(id, { ...dataSource, options: { ...dataSource.options, readOnly: true } }, {});
    try {
      assert.deepEqual(await send({ type: 'edit', edit: { kind: 'hashSet', key: 'session:1', field: 'x', value: '1' } }, 'writeFailed'), {
        type: 'writeFailed',
        message: 'The data source is read-only.',
      });
      const refused = await send({ type: 'cli', line: 'DEL session:1' }, 'cli');
      assert.equal(refused.output, '(error) The data source is read-only; DEL writes data.');
      assert.equal((await send({ type: 'cli', line: 'EXISTS session:1' }, 'cli')).output, '(integer) 1');
    } finally {
      await api.store.save(id, dataSource, {});
    }
  });

  test('exports every item of a key', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'datakit-redis-')), 'queue.json');
    const saved = await stubbing('showSaveDialog', vscode.Uri.file(file), () => send({ type: 'export', key: 'queue:emails', format: 'json' }, 'notice'));
    assert.equal(saved.message, 'Saved 3 rows to queue.json.');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [
      { index: 0, value: 'a' },
      { index: 1, value: 'b' },
      { index: 2, value: 'c' },
    ]);
  });

  test('Browse Keys on a data source connects and opens the database it is set to', async () => {
    const other = (await api.store.save(null, redisSettings({ name: 'sessions', database: '3' }), { password: 'datakit' })).id;
    const node = api.tree.nodeFor(other);
    assert.equal(api.tree.getTreeItem(node).contextValue, 'dataSource.disconnected.redis');
    const init = new Promise<Reply<'init'>>((resolve) => {
      const listener = api.onDidPostRedis(({ dataSourceId, message }) => {
        if (dataSourceId !== other || message.type !== 'init') return;
        listener.dispose();
        resolve(message);
      });
    });
    await vscode.commands.executeCommand('datakit.openRedisKeys', node);
    assert.equal(api.sessions.status(other), 'connected');
    const { init: started } = await init;
    assert.equal(started.dataSourceName, 'sessions');
    assert.equal(started.database, 3);

    // After switching the open key browser to another database, running it again goes back to the one it is set to.
    await api.sendToRedis(other, { type: 'select', database: 1 });
    const back = new Promise<Reply<'database'>>((resolve) => {
      const listener = api.onDidPostRedis(({ dataSourceId, message }) => {
        if (dataSourceId !== other || message.type !== 'database') return;
        listener.dispose();
        resolve(message);
      });
    });
    await vscode.commands.executeCommand('datakit.openRedisKeys', node);
    assert.equal((await back).database, 3);

    // Run again, it brings the open key browser to the front instead of opening another, and does not connect.
    await api.sessions.disconnect(other);
    await vscode.commands.executeCommand('datakit.openRedisKeys', node);
    assert.equal(api.sessions.status(other), 'idle');
    // The tab list learns of a new title a moment after the panel gets it.
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label.startsWith('sessions · '));
    for (let i = 0; i < 20 && tabs()[0]?.label !== 'sessions · db3'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      tabs().map((t) => t.label),
      ['sessions · db3'],
    );
  });
});
