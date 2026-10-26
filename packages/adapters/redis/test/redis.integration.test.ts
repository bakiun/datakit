import { createDataSourceSettings, planEdit, type DataSourceSettings, type RedisEdit } from '@datakit/core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openRedisSession, parseRedisVersion, testRedisConnection, type RedisClientSession } from '../src';

const PASSWORD = 'redis-secret';
const SSH_PASSWORD = 'ssh-secret';

let network: StartedNetwork;
let redis8: StartedRedisContainer;
let redis72: StartedRedisContainer;
let sshd: StartedTestContainer;

function settings(server: StartedRedisContainer, patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('redis');
  s.name = 'cache';
  s.host = server.getHost();
  s.port = String(server.getPort());
  patch(s);
  return s;
}

beforeAll(async () => {
  network = await new Network().start();
  [redis8, redis72, sshd] = await Promise.all([
    new RedisContainer('redis:8.0').withNetwork(network).withNetworkAliases('redis').withPassword(PASSWORD).start(),
    new RedisContainer('redis:7.2').withPassword(PASSWORD).start(),
    new GenericContainer('testcontainers/sshd:1.2.0')
      .withNetwork(network)
      .withExposedPorts(22)
      .withEnvironment({ USERNAME: 'root', PASSWORD: SSH_PASSWORD })
      .start(),
  ]);
  await redis8.exec(['redis-cli', '-a', PASSWORD, '--no-auth-warning', 'ACL', 'SETUSER', 'reader', 'on', '>reader-secret', '~*', '&*', '+@all']);
});

afterAll(async () => {
  await Promise.all([redis8?.stop(), redis72?.stop(), sshd?.stop()]);
  await network?.stop();
});

describe('connecting', () => {
  it('logs in with the password, as an ACL user or fails with the server error', async () => {
    expect((await testRedisConnection(settings(redis8), { password: PASSWORD })).serverVersion).toMatchObject({ product: 'Redis', version: expect.stringMatching(/^8\.0\./) });
    const acl = settings(redis8, (s) => {
      s.auth = 'acl';
      s.user = 'reader';
    });
    expect((await testRedisConnection(acl, { password: 'reader-secret' })).serverVersion.product).toBe('Redis');
    await expect(testRedisConnection(settings(redis8), { password: 'wrong' })).rejects.toThrow(/WRONGPASS/);
    await expect(testRedisConnection(settings(redis8, (s) => (s.port = '1')), {})).rejects.toThrow(/^Connection refused/);
  });

  it('reaches the server through an SSH tunnel', async () => {
    const tunneled = settings(redis8, (s) => {
      s.host = 'redis';
      s.port = '6379';
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
    });
    const session = await openRedisSession(tunneled, { password: PASSWORD, sshPassword: SSH_PASSWORD });
    expect(await session.command(['PING'])).toEqual({ kind: 'status', text: 'PONG' });
    await session.close();
  });

  it('tells Valkey from Redis', () => {
    expect(parseRedisVersion('# Server\r\nredis_version:7.2.4\r\nserver_name:valkey\r\nvalkey_version:8.0.1\r\n')).toEqual({ product: 'Valkey', version: '8.0.1' });
    expect(parseRedisVersion('# Server\r\nredis_version:7.4.1\r\n')).toEqual({ product: 'Redis', version: '7.4.1' });
  });
});

describe.each([
  ['Redis 8.0', () => redis8, true],
  ['Redis 7.2', () => redis72, false],
])('key browser on %s', (_, server, fieldTtl) => {
  let session: RedisClientSession;
  const edit = (e: RedisEdit) => session.write(planEdit(e));

  beforeEach(async () => {
    session?.close();
    session = await openRedisSession(settings(server(), (s) => (s.database = '2')), { password: PASSWORD });
    await session.command(['FLUSHDB']);
    await session.command(['SET', 'user:1', '{"id":1}']);
    await session.command(['HSET', 'session:1', 'user', '1', 'cart', '[1,2]']);
    await session.command(['RPUSH', 'queue', 'a', 'b', 'c', 'b']);
    await session.command(['SADD', 'flags', 'x', 'y']);
    await session.command(['ZADD', 'board', '1.5', 'm1', '2', 'm2', 'inf', 'm3']);
    await session.command(['XADD', 'events', '1-1', 'kind', 'login']);
    await session.command(['XADD', 'events', '1-2', 'kind', 'logout']);
    await session.command(['EXPIRE', 'session:1', '300']);
  });

  afterAll(() => session?.close());

  it('lists databases with their key counts', async () => {
    const databases = await session.databases();
    expect(databases).toHaveLength(16);
    expect(databases[2]).toEqual({ index: 2, keys: 6 });
    expect(session.database).toBe(2);
  });

  it('scans keys with a pattern and a type, with their TTL', async () => {
    const all = await session.scan('0', { match: '*', type: null, count: 100, want: 100 });
    expect(all.cursor).toBe('0');
    expect(all.keys.map((k) => k.key).sort()).toEqual(['board', 'events', 'flags', 'queue', 'session:1', 'user:1']);
    expect(all.keys.find((k) => k.key === 'session:1')).toEqual({ key: 'session:1', type: 'hash', ttl: expect.any(Number) });
    expect((await session.scan('0', { match: 's*', type: 'hash', count: 100, want: 100 })).keys.map((k) => k.key)).toEqual(['session:1']);
  });

  it('describes keys and reads each type in pages', async () => {
    expect(await session.describeKey('queue')).toMatchObject({ type: 'list', length: 4, ttl: null, encoding: expect.any(String) });
    expect(await session.describeKey('nope')).toBeNull();
    expect(await session.readValue('user:1', 'string', null, 10, 4)).toEqual({ type: 'string', value: '{"id', length: 8, truncated: true });

    const first = await session.readValue('queue', 'list', null, 3, 1000);
    expect(first).toEqual({ type: 'list', rows: [{ index: 0, value: 'a' }, { index: 1, value: 'b' }, { index: 2, value: 'c' }], next: 3 });
    expect(await session.readValue('queue', 'list', 3, 3, 1000)).toEqual({ type: 'list', rows: [{ index: 3, value: 'b' }], next: null });

    const hash = await session.readValue('session:1', 'hash', null, 100, 1000);
    expect(hash).toMatchObject({ type: 'hash', next: null });
    expect(hash.type === 'hash' && hash.rows.map((r) => [r.field, r.value])).toEqual(expect.arrayContaining([['user', '1'], ['cart', '[1,2]']]));
    expect(await session.readValue('board', 'zset', null, 100, 1000)).toMatchObject({ rows: [{ member: 'm1', score: '1.5' }, { member: 'm2', score: '2' }, { member: 'm3', score: 'inf' }] });
    expect(await session.readValue('events', 'stream', null, 1, 1000)).toEqual({ type: 'stream', rows: [{ id: '1-1', fields: [['kind', 'login']] }], next: '1-1' });
    expect(await session.readValue('events', 'stream', '1-1', 1, 1000)).toMatchObject({ rows: [{ id: '1-2' }] });
  });

  it('deletes list elements by position and refuses when the list changed', async () => {
    await edit({ kind: 'listDelete', key: 'queue', items: [{ index: 1, expected: 'b' }] });
    expect(await session.command(['LRANGE', 'queue', '0', '-1'])).toEqual({ kind: 'array', items: ['a', 'c', 'b'].map((value) => ({ kind: 'bulk', value })) });
    await expect(edit({ kind: 'listSet', key: 'queue', index: 0, value: 'z', expected: 'not-a' })).rejects.toThrow('The list changed since it was loaded; reload it.');
  });

  it('renames fields, members and keys without overwriting', async () => {
    await edit({ kind: 'hashRenameField', key: 'session:1', from: 'user', to: 'user_id', value: '1' });
    expect(await session.command(['HGET', 'session:1', 'user_id'])).toEqual({ kind: 'bulk', value: '1' });
    await expect(edit({ kind: 'hashRenameField', key: 'session:1', from: 'user_id', to: 'cart', value: '1' })).rejects.toThrow('already has a field “cart”');
    await edit({ kind: 'zsetRename', key: 'board', from: 'm1', to: 'm9', score: '1.5' });
    expect(await session.command(['ZSCORE', 'board', 'm9'])).toEqual({ kind: 'bulk', value: '1.5' });
    await expect(edit({ kind: 'renameKey', key: 'flags', to: 'queue' })).rejects.toThrow('A key named “queue” already exists.');
    await edit({ kind: 'renameKey', key: 'flags', to: 'features' });
    expect(await session.describeKey('features')).toMatchObject({ type: 'set' });
  });

  it('creates keys, keeps TTLs on string writes and sets field TTLs where the server has them', async () => {
    await edit({ kind: 'createKey', key: 'fresh', type: 'hash', ttl: 120, first: 'f', second: 'v' });
    expect(await session.describeKey('fresh')).toMatchObject({ type: 'hash', length: 1, ttl: expect.any(Number) });
    await expect(edit({ kind: 'createKey', key: 'fresh', type: 'string', ttl: null, first: 'x', second: '' })).rejects.toThrow('already exists');

    await session.command(['EXPIRE', 'user:1', '500']);
    await edit({ kind: 'setString', key: 'user:1', value: '{"id":2}', ttl: 500, keepTtl: true });
    expect((await session.describeKey('user:1'))?.ttl).toBeGreaterThan(400);

    if (fieldTtl) {
      await edit({ kind: 'hashFieldTtl', key: 'session:1', field: 'cart', ttl: 90 });
      const hash = await session.readValue('session:1', 'hash', null, 100, 1000);
      expect(hash.type === 'hash' && hash.rows.find((r) => r.field === 'cart')?.ttl).toBeGreaterThan(80);
    } else {
      expect(session.fieldTtl).toBe(false);
    }
  });

  it('keeps binary keys and values intact', async () => {
    await session.write({ watch: [], checks: [], commands: [['SET', { hex: 'ff00' }, { hex: 'c328' }]] });
    const { keys } = await session.scan('0', { match: '*', type: 'string', count: 100, want: 100 });
    expect(keys.map((k) => k.key)).toContainEqual({ hex: 'ff00' });
    expect(await session.readValue({ hex: 'ff00' }, 'string', null, 10, 1000)).toMatchObject({ value: { hex: 'c328' }, truncated: false });
  });

  it('runs CLI commands, follows SELECT and refuses commands that would take over the connection', async () => {
    expect(await session.command(['HGET', 'session:1', 'user'])).toEqual({ kind: 'bulk', value: '1' });
    expect(await session.command(['GET', 'missing'])).toEqual({ kind: 'nil' });
    expect(await session.command(['NOPE'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/unknown command/i) });
    expect(await session.command(['SUBSCRIBE', 'news'])).toEqual({ kind: 'error', message: 'SUBSCRIBE cannot be used in this console.' });
    expect(await session.command(['select', '3'])).toEqual({ kind: 'status', text: 'OK' });
    expect(session.database).toBe(3);
    expect(await session.commandFlags('set')).toContain('write');
    expect(await session.commandFlags('get')).toContain('readonly');
    expect(await session.commandFlags('nope')).toBeNull();
  });
});
