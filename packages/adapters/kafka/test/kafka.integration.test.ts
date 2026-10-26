import { createServer, type AddressInfo } from 'node:net';
import { createDataSourceSettings, type DataSourceSettings, type KafkaAcl, type KafkaMessage, type KafkaMessageQuery } from '@datakit/core';
import { Consumer, murmur2, Producer } from '@platformatic/kafka';
import { GenericContainer, Network, Wait, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openKafkaSession, testKafkaConnection, type KafkaClientSession } from '../src';

const KAFKA_IMAGE = 'apache/kafka:4.0.0';
const CLUSTER_ID = '4L6g3nShT-eMCtK--X86sw';
/** Shared by both brokers: StandardAuthorizer with ACLs optional, and the anonymous inter-broker user as super user. */
const AUTHORIZER = {
  KAFKA_AUTHORIZER_CLASS_NAME: 'org.apache.kafka.metadata.authorizer.StandardAuthorizer',
  KAFKA_ALLOW_EVERYONE_IF_NO_ACL_FOUND: 'true',
  KAFKA_SUPER_USERS: 'User:admin;User:ANONYMOUS',
};
const SASL_USERS = { admin: 'admin-secret', alice: 'alice-secret' };

let network: StartedNetwork;
let kafka: StartedTestContainer;
let plainPort: number;
let saslPort: number;
let session: KafkaClientSession;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function settings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('kafka');
  s.name = 'events';
  s.kafka.bootstrapServers = `127.0.0.1:${plainPort}`;
  patch(s);
  return s;
}

const sasl = (user: string) => (s: DataSourceSettings) => {
  s.kafka.bootstrapServers = `127.0.0.1:${saslPort}`;
  s.auth = 'password';
  s.kafka.saslMechanism = 'PLAIN';
  s.user = user;
};

const query = (topic: string, patch: Partial<KafkaMessageQuery> = {}): KafkaMessageQuery => ({
  topic,
  limit: 100,
  partition: null,
  fromOffset: null,
  toOffset: null,
  fromTime: null,
  toTime: null,
  text: null,
  ...patch,
});

const values = (messages: KafkaMessage[]) => messages.map((m) => m.value?.text ?? null);

/** Waits until `check` stops throwing, for metadata that brokers apply a moment after a request. */
async function eventually<T>(check: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

beforeAll(async () => {
  network = await new Network().start();
  [plainPort, saslPort] = [await freePort(), await freePort()];
  const jaas = `org.apache.kafka.common.security.plain.PlainLoginModule required username="admin" password="${SASL_USERS.admin}" ${Object.entries(SASL_USERS)
    .map(([user, password]) => `user_${user}="${password}"`)
    .join(' ')};`;
  kafka = await new GenericContainer(KAFKA_IMAGE)
    .withNetwork(network)
    .withNetworkAliases('kafka')
    .withExposedPorts({ container: 9092, host: plainPort }, { container: 9094, host: saslPort }, 9095)
    .withEnvironment({
      CLUSTER_ID,
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093,SASL://:9094,DOCKER://:9095',
      // Clients on this machine use the mapped ports; containers on the network use kafka:9095.
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${plainPort},SASL://127.0.0.1:${saslPort},DOCKER://kafka:9095`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,SASL:SASL_PLAINTEXT,DOCKER:PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'DOCKER',
      KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
      KAFKA_LISTENER_NAME_SASL_PLAIN_SASL_JAAS_CONFIG: jaas,
      ...AUTHORIZER,
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_NUM_PARTITIONS: '1',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(180_000)
    .start();
  session = await openKafkaSession(settings(), {});
});

afterAll(async () => {
  await session?.close();
  await kafka?.stop();
  await network?.stop();
});

describe('connecting', () => {
  it('reads the release from metadata.version', async () => {
    const result = await testKafkaConnection(settings(), {});
    expect(result.serverVersion).toEqual({ product: 'Kafka', version: '4.0' });
    expect(session.kind).toBe('kafka');
    expect(session.schemaRegistry).toBeNull();
  });

  it('logs in with SASL PLAIN and fails clearly with a wrong password', async () => {
    expect((await testKafkaConnection(settings(sasl('alice')), { password: SASL_USERS.alice })).serverVersion.version).toBe('4.0');
    await expect(testKafkaConnection(settings(sasl('alice')), { password: 'wrong' })).rejects.toThrow(/^SASL authentication failed \(127\.0\.0\.1:\d+\): .*Invalid username or password/);
  });

  it('fails fast on a port nobody listens on', async () => {
    const started = Date.now();
    await expect(testKafkaConnection(settings((s) => (s.kafka.bootstrapServers = '127.0.0.1:1')), {})).rejects.toThrow(/^Connection refused \(127\.0\.0\.1:1\)\.$/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('explains a security protocol the listener does not speak', async () => {
    const started = Date.now();
    await expect(testKafkaConnection(settings((s) => (s.kafka.bootstrapServers = `127.0.0.1:${saslPort}`)), {})).rejects.toThrow(
      /^The broker closed the connection \(127\.0\.0\.1:\d+\)\. Check the security protocol: the listener may expect SASL or TLS\.$/,
    );
    const saslOnPlain = settings((s) => {
      sasl('alice')(s);
      s.kafka.bootstrapServers = `127.0.0.1:${plainPort}`;
    });
    await expect(testKafkaConnection(saslOnPlain, { password: 'x' })).rejects.toThrow(/^Cannot find a suitable SASL mechanism .* Check the SASL mechanism, and that the listener uses SASL\.$/);
    await expect(testKafkaConnection(settings((s) => (s.ssl.enabled = true)), {})).rejects.toThrow(/^Connection reset by the server .* the listener may not use TLS\.$/);
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(session.deleteTopic('missing')).rejects.toThrow('Topic missing does not exist.');
  });

  it('says when the advertised brokers cannot be reached', async () => {
    // The listener for containers advertises kafka:9095, a name only the Docker network knows.
    const internal = settings((s) => (s.kafka.bootstrapServers = `127.0.0.1:${kafka.getMappedPort(9095)}`));
    await expect(testKafkaConnection(internal, {})).rejects.toThrow(
      'The cluster advertises its brokers as kafka:9095, which cannot be reached from here: Host not found (kafka:9095).',
    );
  });

  it('fires onDidClose once when closed', async () => {
    const other = await openKafkaSession(settings(), {});
    let calls = 0;
    other.onDidClose(() => calls++);
    await other.close();
    await other.close();
    expect(calls).toBe(1);
  });
});

describe('cluster', () => {
  it('describes the broker, its log dirs and configs', async () => {
    const [broker] = await session.brokers();
    expect(broker).toMatchObject({ id: 1, host: '127.0.0.1', port: plainPort, controller: expect.any(Boolean), online: true });
    expect(broker!.logDirs[0]).toMatchObject({ path: '/tmp/kafka-logs', bytes: expect.any(Number), totalBytes: expect.any(Number), usableBytes: expect.any(Number) });
    const configs = await session.brokerConfigs(1);
    expect(configs.find((c) => c.name === 'node.id')).toMatchObject({ value: '1', source: 'static', readOnly: true, documentation: expect.any(String) });
    expect(configs.find((c) => c.name === 'log.retention.hours')).toMatchObject({ source: 'default' });
    // The broker applies dynamic configs once they reach it through the metadata log.
    const threads = () => session.brokerConfigs(1).then((c) => c.find((e) => e.name === 'log.cleaner.threads'));
    await session.setBrokerConfig(1, 'log.cleaner.threads', '2');
    await eventually(async () => expect(await threads()).toMatchObject({ value: '2', source: 'broker' }));
    await session.setBrokerConfig(1, 'log.cleaner.threads', null);
    await eventually(async () => expect((await threads())?.source).toBe('default'));
    await expect(session.brokerConfigs(7)).rejects.toThrow('Broker 7 is not in the cluster.');
  });
});

describe('topics', () => {
  it('creates, lists, describes, configures, grows, clears and deletes a topic', async () => {
    await session.createTopic({ name: 'inventory', partitions: 2, replicationFactor: 1, configs: { 'retention.ms': '86400000' } });
    await expect(session.createTopic({ name: 'inventory', partitions: 1, replicationFactor: 1, configs: {} })).rejects.toThrow(/already exists/);
    await expect(session.createTopic({ name: 'wide', partitions: 1, replicationFactor: 3, configs: {} })).rejects.toThrow(/replication factor/i);

    await eventually(async () => expect((await session.topic('inventory'))?.partitionInfo.every((p) => p.leader === 1)).toBe(true));
    await session.produce('inventory', Array.from({ length: 5 }, (_, i) => ({ partition: i % 2, key: null, value: `item-${i}`, headers: [] })), 'string');

    const summary = (await session.topics()).find((t) => t.name === 'inventory');
    expect(summary).toMatchObject({ internal: false, partitions: 2, replicationFactor: 1, messages: 5, retentionMs: 86_400_000, cleanupPolicy: 'delete', underReplicated: 0 });
    expect(summary!.bytes).toEqual(expect.any(Number));
    expect(await session.topic('missing')).toBeNull();

    const detail = await session.topic('inventory');
    expect(detail!.partitionInfo).toEqual([
      { partition: 0, leader: 1, replicas: [1], isr: [1], start: '0', end: '3' },
      { partition: 1, leader: 1, replicas: [1], isr: [1], start: '0', end: '2' },
    ]);

    const retention = () => session.topicConfigs('inventory').then((c) => c.find((e) => e.name === 'retention.ms'));
    expect(await retention()).toMatchObject({ value: '86400000', source: 'topic', readOnly: false, sensitive: false });
    await session.setTopicConfig('inventory', 'retention.ms', '3600000');
    expect(await retention()).toMatchObject({ value: '3600000', source: 'topic' });
    await session.setTopicConfig('inventory', 'retention.ms', null);
    expect((await retention())?.source).not.toBe('topic');
    await expect(session.setTopicConfig('inventory', 'retention.ms', 'soon')).rejects.toThrow(/retention\.ms/);
    await expect(session.topicConfigs('missing')).rejects.toThrow('Topic missing does not exist.');

    await session.addPartitions('inventory', 3);
    await eventually(async () => expect((await session.topic('inventory'))?.partitions).toBe(3));

    expect(await session.clearTopic('inventory')).toBe(5);
    expect((await session.topic('inventory'))?.partitionInfo.map((p) => [p.start, p.end])).toEqual([
      ['3', '3'],
      ['2', '2'],
      ['0', '0'],
    ]);

    await session.createTopic({ name: 'profiles', partitions: 1, replicationFactor: 1, configs: { 'cleanup.policy': 'compact' } });
    await expect(session.clearTopic('profiles')).rejects.toThrow(/compacted \(cleanup\.policy=compact\)/);

    await expect(session.changeReplicationFactor('inventory', 2)).rejects.toThrow('A replication factor of 2 needs 2 brokers; the cluster has 1.');
    await session.changeReplicationFactor('inventory', 1);

    await session.deleteTopic('inventory');
    await eventually(async () => expect(await session.topic('inventory')).toBeNull());
  });

  it('lists a few hundred topics in a few requests', async () => {
    await Promise.all(Array.from({ length: 300 }, (_, i) => session.createTopic({ name: `bulk-${i}`, partitions: 2, replicationFactor: 1, configs: {} })));
    await eventually(async () => {
      const topics = (await session.topics()).filter((t) => t.name.startsWith('bulk-'));
      expect(topics).toHaveLength(300);
    }, 30_000);
    const started = Date.now();
    const topics = await session.topics();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(topics.find((t) => t.name === 'bulk-299')).toMatchObject({ partitions: 2, messages: 0, retentionMs: 604_800_000, cleanupPolicy: 'delete' });
    await Promise.all(Array.from({ length: 300 }, (_, i) => session.deleteTopic(`bulk-${i}`)));
  });
});

describe('messages', () => {
  const topic = 'orders';
  let produced: { partition: number; offset: string }[];
  let middle: number;
  // Where the Java client puts key `k`: murmur2, made positive, modulo the partitions.
  const keyed = (murmur2(Buffer.from('k')) & 0x7fffffff) % 3;
  const ends = () => ({ '0': keyed === 0 ? '11' : '10', '1': keyed === 1 ? '12' : '11', '2': keyed === 2 ? '11' : '10' });

  beforeAll(async () => {
    await session.createTopic({ name: topic, partitions: 3, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await session.topic(topic))?.partitionInfo.every((p) => p.leader === 1)).toBe(true));
    produced = await session.produce(
      topic,
      Array.from({ length: 30 }, (_, i) => ({ partition: i % 3, key: `order-${i}`, value: JSON.stringify({ id: i, status: i === 7 ? 'Refunded' : 'paid' }), headers: [{ key: 'source', value: i < 15 ? 'web' : 'app' }] })),
      'json',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    middle = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 20));
    produced.push(...(await session.produce(topic, [{ partition: 1, key: null, value: '-42', headers: [] }], 'int64')));
    await new Promise((resolve) => setTimeout(resolve, 5));
    produced.push(...(await session.produce(topic, [{ partition: null, key: 'k', value: null, headers: [] }], 'string')));
  });

  it('returns the partition and offset of every record', () => {
    expect(produced).toHaveLength(32);
    expect(produced.slice(0, 6)).toEqual([
      { partition: 0, offset: '0' },
      { partition: 1, offset: '0' },
      { partition: 2, offset: '0' },
      { partition: 0, offset: '1' },
      { partition: 1, offset: '1' },
      { partition: 2, offset: '1' },
    ]);
    expect(produced[30]).toEqual({ partition: 1, offset: '10' });
    expect(produced[31]).toEqual({ partition: keyed, offset: keyed === 1 ? '11' : '10' });
  });

  it('reads the newest messages first across partitions, with positions', async () => {
    const page = await session.readMessages(query(topic, { limit: 5 }));
    expect(page.messages).toHaveLength(5);
    expect(page.partial).toBe(false);
    expect(page.positions).toEqual(ends());
    const times = page.messages.map((m) => m.timestamp);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // The tombstone and the int64 value are the newest two.
    const [newest, second] = page.messages;
    expect(newest!.value).toBeNull();
    expect(newest!.key?.text).toBe('k');
    expect(second).toMatchObject({ partition: 1, offset: '10', value: { text: 'ffffffffffffffd6', binary: true, size: 8, schemaId: null } });

    const all = await session.readMessages(query(topic));
    expect(all.messages).toHaveLength(32);
    const first = all.messages.at(-1)!;
    expect(first).toMatchObject({ partition: 0, offset: '0', key: { text: 'order-0', binary: false }, headers: [{ key: 'source', value: 'web' }] });
    expect(JSON.parse(first.value!.text)).toEqual({ id: 0, status: 'paid' });
  });

  it('filters by partition, offset range, time range and text', async () => {
    const partition = await session.readMessages(query(topic, { partition: 2, limit: 4 }));
    const last = keyed === 2 ? 10 : 9;
    expect(partition.messages.map((m) => [m.partition, m.offset])).toEqual([0, 1, 2, 3].map((i) => [2, String(last - i)]));
    const range = await session.readMessages(query(topic, { partition: 0, fromOffset: '2', toOffset: '4' }));
    expect(range.messages.map((m) => m.offset)).toEqual(['4', '3', '2']);

    const before = await session.readMessages(query(topic, { toTime: middle }));
    expect(before.messages).toHaveLength(30);
    const after = await session.readMessages(query(topic, { fromTime: middle }));
    expect(after.messages.map((m) => [m.partition, m.offset])).toEqual([
      [keyed, keyed === 1 ? '11' : '10'],
      [1, '10'],
    ]);

    const text = await session.readMessages(query(topic, { text: 'refunded' }));
    expect(text.messages.map((m) => m.key?.text)).toEqual(['order-7']);
    expect(text.scanned).toBe(32);
    const header = await session.readMessages(query(topic, { text: 'APP', limit: 3 }));
    expect(header.messages).toHaveLength(3);
    expect(header.messages.every((m) => m.headers[0]?.value === 'app')).toBe(true);

    await expect(session.readMessages(query(topic, { partition: 9 }))).rejects.toThrow('Partition 9 does not exist; orders has 3 partitions.');
    await expect(session.readMessages(query('nope'))).rejects.toThrow('Topic nope does not exist.');
  });

  it('cuts large payloads in pages but not in readAll', async () => {
    await session.createTopic({ name: 'blobs', partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await session.topic('blobs'))?.partitionInfo[0]?.leader).toBe(1));
    await session.produce('blobs', [{ partition: 0, key: null, value: 'x'.repeat(100_000), headers: [] }], 'string');
    const [message] = (await session.readMessages(query('blobs'))).messages;
    expect(message!.value).toMatchObject({ size: 100_000, truncated: true });
    expect(message!.value!.text).toHaveLength(64 * 1024);

    const chunks: KafkaMessage[][] = [];
    expect(await session.readAll('blobs', (messages) => (chunks.push(messages), true))).toBe(1);
    expect(chunks[0]![0]!.value).toMatchObject({ size: 100_000, truncated: false });
    expect(chunks[0]![0]!.value!.text).toHaveLength(100_000);
  });

  it('reads every message oldest first and can stop', async () => {
    const read: KafkaMessage[] = [];
    let total = 0;
    expect(
      await session.readAll(topic, (messages, count, all) => {
        read.push(...messages);
        total = all;
        expect(count).toBe(read.length);
        return true;
      }),
    ).toBe(32);
    expect(total).toBe(32);
    expect(new Set(read.map((m) => `${m.partition}:${m.offset}`)).size).toBe(32);
    expect(await session.readAll(topic, () => false)).toBeGreaterThan(0);
    const disk = Object.assign(new Error('EACCES: permission denied, open export.json'), { code: 'EACCES' });
    await expect(
      session.readAll(topic, () => {
        throw disk;
      }),
    ).rejects.toBe(disk);
  });

  it('tails new messages from the positions of a page', async () => {
    const { positions } = await session.readMessages(query(topic, { limit: 1 }));
    const quiet = await session.tail(topic, positions, 200);
    expect(quiet).toEqual({ messages: [], positions });

    const waiting = session.tail(topic, positions, 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await session.produce(topic, [{ partition: 2, key: null, value: 'live', headers: [] }], 'string');
    const live = await waiting;
    expect(values(live.messages)).toEqual(['live']);
    expect(live.positions['2']).toBe(String(Number(positions['2']) + 1));

    // A partition the positions do not name starts at its end.
    const { ['0']: _, ...withoutZero } = live.positions;
    await session.produce(topic, [{ partition: 0, key: null, value: 'later', headers: [] }], 'string');
    const next = await session.tail(topic, withoutZero, 200);
    expect(next.messages).toEqual([]);
    expect(next.positions['0']).toBe((await session.topic(topic))!.partitionInfo[0]!.end);
  });

  it('tells the format of the newest message', async () => {
    await session.createTopic({ name: 'formats', partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await session.topic('formats'))?.partitionInfo[0]?.leader).toBe(1));
    expect(await session.sampleFormat('formats')).toBeNull();
    await session.produce('formats', [{ partition: 0, key: null, value: '{"a":1}', headers: [] }], 'json');
    expect(await session.sampleFormat('formats')).toBe('JSON');
    await session.produce('formats', [{ partition: 0, key: null, value: 'hello', headers: [] }], 'string');
    expect(await session.sampleFormat('formats')).toBe('String');
    await session.produce('formats', [{ partition: 0, key: null, value: '-1', headers: [] }], 'int64');
    expect(await session.sampleFormat('formats')).toBe('Binary');
  });

  it('reads inside compressed batches and over transaction markers', async () => {
    for (const name of ['zipped', 'transactional']) {
      await session.createTopic({ name, partitions: 1, replicationFactor: 1, configs: {} });
      await eventually(async () => expect((await session.topic(name))?.partitionInfo[0]?.leader).toBe(1));
    }
    const brokers = [`127.0.0.1:${plainPort}`];
    const batch = (topic: string, n: number) => Array.from({ length: n }, (_, i) => ({ topic, partition: 0, value: Buffer.from(`${topic}-${i}`) }));
    const zipper = new Producer({ clientId: 'test-gzip', bootstrapBrokers: brokers, compression: 'gzip' });
    await zipper.send({ messages: batch('zipped', 10) });
    await zipper.close();
    // A fetch from offset 3 returns the whole batch; only 3 to 5 are asked for.
    expect(values((await session.readMessages(query('zipped', { fromOffset: '3', toOffset: '5' }))).messages)).toEqual(['zipped-5', 'zipped-4', 'zipped-3']);
    expect(values((await session.readMessages(query('zipped', { limit: 2 }))).messages)).toEqual(['zipped-9', 'zipped-8']);

    const transactional = new Producer({ clientId: 'test-tx', bootstrapBrokers: brokers, idempotent: true, transactionalId: 'datakit-test' });
    for (const round of [0, 1]) {
      const tx = await transactional.beginTransaction();
      await tx.send({ messages: batch('transactional', 2).map((m, i) => ({ ...m, value: Buffer.from(`tx-${round}-${i}`) })) });
      await tx.commit();
    }
    await transactional.close();
    // Offsets 0, 1, 3 and 4 hold records; 2 and 5 commit markers.
    const page = await session.readMessages(query('transactional', { limit: 3 }));
    expect(page.messages.map((m) => m.offset)).toEqual(['4', '3', '1']);
    expect(page.positions).toEqual({ '0': '6' });
    expect(values(page.messages)).toEqual(['tx-1-1', 'tx-1-0', 'tx-0-1']);
  });

  it('stops a text search at its budget and says so', async () => {
    await session.createTopic({ name: 'logs', partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await session.topic('logs'))?.partitionInfo[0]?.leader).toBe(1));
    await session.produce('logs', Array.from({ length: 25_000 }, (_, i) => ({ partition: 0, key: null, value: `line ${i}`, headers: [] })), 'string');
    const page = await session.readMessages(query('logs', { text: 'needle', limit: 10 }));
    expect(page).toMatchObject({ messages: [], partial: true, scanned: 20_000 });
    // Fewer matches than the limit: the search reads on until its budget.
    const found = await session.readMessages(query('logs', { text: 'line 24990', limit: 10 }));
    expect(found).toMatchObject({ partial: true, scanned: 20_000 });
    expect(values(found.messages)).toEqual(['line 24990']);
    const enough = await session.readMessages(query('logs', { text: 'line 2499', limit: 2 }));
    expect(enough).toMatchObject({ partial: false, scanned: 2000 });
    expect(values(enough.messages)).toEqual(['line 24999', 'line 24998']);
    const whole = await session.readMessages(query('logs', { text: 'line 3', fromOffset: '20000', limit: 1000 }));
    expect(whole.partial).toBe(false);
    expect(whole.scanned).toBe(5000);
  });

  it('refuses values it cannot encode', async () => {
    await expect(session.produce(topic, [{ partition: null, key: null, value: '1.5', headers: [] }], 'int64')).rejects.toThrow(/whole number/);
    await expect(session.produce(topic, [{ partition: 7, key: null, value: 'x', headers: [] }], 'string')).rejects.toThrow('Partition 7 does not exist; orders has 3 partitions.');
    await expect(session.produce(topic, [{ partition: null, key: null, value: '{}', headers: [] }], 'avro')).rejects.toThrow('Avro needs a Schema Registry URL on the data source.');
  });
});

describe('consumer groups', () => {
  const topic = 'payments';
  const groupId = 'billing';

  const consumer = () =>
    new Consumer({ clientId: 'test-consumer', bootstrapBrokers: [`127.0.0.1:${plainPort}`], groupId, autocommit: false, maxWaitTime: 200, sessionTimeout: 10_000, heartbeatInterval: 500 });

  /** Joins the group, reads `count` messages, commits the last one and, unless kept, leaves. */
  async function consume(count: number, keep = false) {
    const c = consumer();
    const stream = await c.consume({ topics: [topic], mode: 'earliest' });
    await new Promise<void>((resolve, reject) => {
      let read = 0;
      stream.on('error', reject);
      stream.on('data', (message) => {
        if (++read !== count) return;
        stream.pause();
        Promise.resolve(message.commit()).then(resolve, reject);
      });
    });
    if (keep) return c;
    await stream.close();
    await c.close();
    return null;
  }

  beforeAll(async () => {
    await session.createTopic({ name: topic, partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await session.topic(topic))?.partitionInfo[0]?.leader).toBe(1));
    await session.produce(topic, Array.from({ length: 10 }, (_, i) => ({ partition: 0, key: null, value: `p-${i}`, headers: [] })), 'string');
    await consume(4);
  });

  it('lists groups with their lag', async () => {
    const groups = await eventually(async () => {
      const found = (await session.groups()).find((g) => g.id === groupId);
      expect(found?.state).toBe('Empty');
      return found!;
    });
    expect(groups).toEqual({ id: groupId, state: 'Empty', protocolType: 'consumer', members: 0, lagByTopic: { [topic]: 6 } });
    const overview = await session.overview();
    expect(overview.groups.find((g) => g.id === groupId)?.lagByTopic).toEqual({ [topic]: 6 });
    expect(overview).toMatchObject({ controllerId: 1, offline: [], underReplicated: [], replicationFactors: [1] });
    expect(overview.topics).toBeGreaterThan(0);
  });

  it('describes a group with its offsets', async () => {
    expect(await session.group('nobody')).toBeNull();
    expect(await session.group(groupId)).toMatchObject({
      id: groupId,
      members: 0,
      memberDetails: [],
      offsets: [{ topic, partition: 0, committed: '4', start: '0', end: '10', lag: 6 }],
    });
  });

  it('resets offsets to earliest, latest, a time and an offset', async () => {
    const committed = async () => (await session.group(groupId))!.offsets[0]!.committed;
    await session.resetOffsets(groupId, null, { kind: 'earliest' });
    expect(await committed()).toBe('0');
    await session.resetOffsets(groupId, [{ topic, partition: 0 }], { kind: 'latest' });
    expect(await committed()).toBe('10');
    await session.resetOffsets(groupId, null, { kind: 'offset', offset: '99' });
    expect(await committed()).toBe('10');
    await session.resetOffsets(groupId, null, { kind: 'offset', offset: '3' });
    expect(await committed()).toBe('3');
    await session.resetOffsets(groupId, null, { kind: 'timestamp', time: Date.now() + 60_000 });
    expect(await committed()).toBe('10');
    await session.resetOffsets(groupId, null, { kind: 'timestamp', time: 0 });
    expect(await committed()).toBe('0');
  });

  it('refuses to reset a group with members and shows their assignments', async () => {
    const running = await consume(1, true);
    try {
      const detail = await eventually(async () => {
        const d = await session.group(groupId);
        expect(d?.members).toBe(1);
        return d!;
      });
      expect(detail.memberDetails[0]).toMatchObject({ clientId: 'test-consumer', assignments: [{ topic, partition: 0 }] });
      await expect(session.resetOffsets(groupId, null, { kind: 'earliest' })).rejects.toThrow('billing has 1 active member. Offsets can only be changed after its consumers stop.');
    } finally {
      await running?.close(true);
    }
  });

  it('describes groups of the consumer protocol (KIP-848)', async () => {
    const c = new Consumer({ clientId: 'modern-consumer', bootstrapBrokers: [`127.0.0.1:${plainPort}`], groupId: 'modern', groupProtocol: 'consumer', autocommit: false, maxWaitTime: 200 });
    const stream = await c.consume({ topics: [topic], mode: 'earliest' });
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.once('data', (message) => {
        stream.pause();
        Promise.resolve(message.commit()).then(resolve, reject);
      });
    });
    try {
      const detail = await eventually(async () => {
        const d = await session.group('modern');
        expect(d?.memberDetails[0]?.assignments).toEqual([{ topic, partition: 0 }]);
        return d!;
      });
      expect(detail).toMatchObject({ protocolType: 'consumer', members: 1, memberDetails: [{ clientId: 'modern-consumer' }], offsets: [{ topic, partition: 0, committed: '1', lag: 9 }] });
      expect((await session.groups()).find((g) => g.id === 'modern')).toMatchObject({ members: 1, lagByTopic: { [topic]: 9 } });
    } finally {
      await stream.close();
      await c.close(true);
    }
  });

  it('deletes a group', async () => {
    await eventually(async () => {
      await session.deleteGroup(groupId);
    });
    expect(await session.group(groupId)).toBeNull();
  });
});

describe('ACLs', () => {
  it('creates, lists and deletes ACLs', async () => {
    const acl: KafkaAcl = { principal: 'User:alice', host: '*', resourceType: 'TOPIC', resourceName: 'audit-', patternType: 'PREFIXED', operation: 'READ', permission: 'ALLOW' };
    const deny: KafkaAcl = { ...acl, resourceType: 'GROUP', resourceName: 'ops', patternType: 'LITERAL', operation: 'ALL', permission: 'DENY' };
    expect(await session.acls()).toEqual([]);
    await session.createAcls([acl, deny]);
    await eventually(async () => expect(await session.acls()).toEqual(expect.arrayContaining([acl, deny])));
    expect(await session.deleteAcls([acl])).toBe(1);
    await eventually(async () => expect(await session.acls()).toEqual([deny]));
    expect(await session.deleteAcls([deny, deny])).toBeGreaterThanOrEqual(1);
  });
});

describe('REST services', () => {
  const ORDER_V1 = { type: 'record', name: 'Order', fields: [{ name: 'id', type: 'int' }, { name: 'name', type: 'string' }] };
  const ORDER_V2 = { ...ORDER_V1, fields: [...ORDER_V1.fields, { name: 'note', type: 'string', default: '' }] };
  const services: Partial<Record<'registry' | 'connect' | 'ksqlDb', StartedTestContainer>> = {};
  const failures: Partial<Record<keyof typeof services, string>> = {};
  let rest: KafkaClientSession;

  const url = (name: keyof typeof services, port: number) => (services[name] ? `http://${services[name].getHost()}:${services[name].getMappedPort(port)}` : '');
  /** Skips a test whose service did not start here, with the reason. */
  const needs = (ctx: { skip(condition: boolean, note?: string): void }, name: keyof typeof services) => ctx.skip(!services[name], failures[name]);

  beforeAll(async () => {
    const start = async (name: keyof typeof services, container: GenericContainer) => {
      try {
        services[name] = await container.start();
      } catch (error) {
        failures[name] = `${name} did not start: ${(error as Error).message}`;
        console.warn(failures[name]);
      }
    };
    const connectProperties = [
      'bootstrap.servers=kafka:9095',
      'group.id=datakit-connect',
      'key.converter=org.apache.kafka.connect.storage.StringConverter',
      'value.converter=org.apache.kafka.connect.storage.StringConverter',
      'offset.storage.topic=connect-offsets',
      'config.storage.topic=connect-configs',
      'status.storage.topic=connect-status',
      'offset.storage.replication.factor=1',
      'config.storage.replication.factor=1',
      'status.storage.replication.factor=1',
      'listeners=http://0.0.0.0:8083',
      'rest.advertised.host.name=connect',
      'plugin.path=/opt/kafka/libs/connect-file-4.0.0.jar',
    ].join('\n');
    await Promise.all([
      start(
        'registry',
        new GenericContainer('confluentinc/cp-schema-registry:7.9.1')
          .withNetwork(network)
          .withExposedPorts(8081)
          .withEnvironment({
            SCHEMA_REGISTRY_HOST_NAME: 'schema-registry',
            SCHEMA_REGISTRY_LISTENERS: 'http://0.0.0.0:8081',
            SCHEMA_REGISTRY_KAFKASTORE_BOOTSTRAP_SERVERS: 'PLAINTEXT://kafka:9095',
          })
          .withWaitStrategy(Wait.forHttp('/subjects', 8081))
          .withStartupTimeout(180_000),
      ),
      start(
        'connect',
        new GenericContainer(KAFKA_IMAGE)
          .withNetwork(network)
          .withNetworkAliases('connect')
          .withExposedPorts(8083)
          .withCopyContentToContainer([
            { content: connectProperties, target: '/tmp/connect.properties' },
            { content: 'first line\nsecond line\n', target: '/tmp/source.txt' },
          ])
          .withCommand(['/opt/kafka/bin/connect-distributed.sh', '/tmp/connect.properties'])
          .withWaitStrategy(Wait.forHttp('/connectors', 8083))
          .withStartupTimeout(180_000),
      ),
      start(
        'ksqlDb',
        new GenericContainer('confluentinc/ksqldb-server:0.29.0')
          .withNetwork(network)
          .withExposedPorts(8088)
          .withEnvironment({
            KSQL_BOOTSTRAP_SERVERS: 'kafka:9095',
            KSQL_LISTENERS: 'http://0.0.0.0:8088',
            KSQL_KSQL_SERVICE_ID: 'datakit_',
            KSQL_KSQL_INTERNAL_TOPIC_REPLICAS: '1',
            KSQL_KSQL_STREAMS_REPLICATION_FACTOR: '1',
            KSQL_KSQL_LOGGING_PROCESSING_TOPIC_REPLICATION_FACTOR: '1',
          })
          .withWaitStrategy(Wait.forHttp('/info', 8088))
          .withStartupTimeout(240_000),
      ),
    ]);
    rest = await openKafkaSession(
      settings((s) => {
        s.kafka.schemaRegistryUrl = url('registry', 8081);
        s.kafka.connectUrl = url('connect', 8083);
        s.kafka.ksqlDbUrl = url('ksqlDb', 8088);
      }),
      {},
    );
  });

  afterAll(async () => {
    await rest?.close();
    await Promise.all(Object.values(services).map((c) => c.stop()));
  });

  it('registers schemas, checks compatibility, sets levels and deletes versions', async (ctx) => {
    needs(ctx, 'registry');
    const registry = rest.schemaRegistry!;
    const subject = 'orders-avro-value';
    expect(await registry.subjects()).toEqual([]);
    expect(await registry.checkCompatibility(subject, 'AVRO', JSON.stringify(ORDER_V1))).toEqual({ compatible: true, messages: [] });
    const v1 = await registry.register(subject, 'AVRO', JSON.stringify(ORDER_V1));
    expect(await registry.checkCompatibility(subject, 'AVRO', JSON.stringify(ORDER_V2))).toEqual({ compatible: true, messages: [] });
    const breaking = await registry.checkCompatibility(subject, 'AVRO', JSON.stringify({ ...ORDER_V1, fields: [{ name: 'id', type: 'string' }] }));
    expect(breaking.compatible).toBe(false);
    expect(breaking.messages.length).toBeGreaterThan(0);
    const v2 = await registry.register(subject, 'AVRO', JSON.stringify(ORDER_V2));
    await registry.register('events-json-value', 'JSON', JSON.stringify({ type: 'object', properties: { kind: { type: 'string' } } }));
    await expect(registry.register(subject, 'AVRO', '{"type":"nope"}')).rejects.toThrow(/^Schema Registry: .*\(error 422\d\d\)$/);

    expect(await registry.subjects()).toEqual([
      { name: 'events-json-value', type: 'JSON', latestVersion: 1, latestId: expect.any(Number) },
      { name: subject, type: 'AVRO', latestVersion: 2, latestId: v2 },
    ]);
    expect(await registry.version(subject, 'latest')).toMatchObject({ subject, version: 2, id: v2, type: 'AVRO', versions: [1, 2], compatibility: null });
    expect(JSON.parse((await registry.version(subject, 1)).schema)).toEqual(ORDER_V1);

    expect(await registry.globalCompatibility()).toBe('BACKWARD');
    await registry.setCompatibility(subject, 'FULL');
    expect((await registry.version(subject, 2)).compatibility).toBe('FULL');
    await registry.setCompatibility(subject, null);
    await registry.setCompatibility(subject, null);
    expect((await registry.version(subject, 2)).compatibility).toBeNull();
    await registry.setGlobalCompatibility('NONE');
    expect(await registry.globalCompatibility()).toBe('NONE');
    await registry.setGlobalCompatibility('BACKWARD');

    await registry.register('scratch-value', 'AVRO', JSON.stringify(ORDER_V1));
    await registry.deleteVersion('scratch-value', 1, false);
    await registry.deleteVersion('scratch-value', 1, true);
    expect((await registry.subjects()).map((s) => s.name)).not.toContain('scratch-value');
    await expect(registry.version('scratch-value', 1)).rejects.toThrow(/\(error 4040\d\)$/);
    expect(v1).not.toBe(v2);
  });

  it('produces Avro with the latest schema and decodes it when reading', async (ctx) => {
    needs(ctx, 'registry');
    const topic = 'orders-avro';
    await rest.createTopic({ name: topic, partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await rest.topic(topic))?.partitionInfo[0]?.leader).toBe(1));
    const latest = await rest.schemaRegistry!.version(`${topic}-value`, 'latest');
    await rest.produce(topic, [{ partition: null, key: 'a', value: '{"id":1,"name":"first","note":"note-x"}', headers: [] }], 'avro');
    await expect(rest.produce(topic, [{ partition: null, key: null, value: '{"id":"one","name":"x","note":""}', headers: [] }], 'avro')).rejects.toThrow(
      `The value does not match the schema of ${topic}-value v2 at id.`,
    );
    await expect(rest.produce('payments', [{ partition: null, key: null, value: '{}', headers: [] }], 'avro')).rejects.toThrow(/no subject payments-value/);

    const [message] = (await rest.readMessages(query(topic))).messages;
    expect(message!.value).toMatchObject({ schemaId: latest.id, decoded: '{"id":1,"name":"first","note":"note-x"}' });
    expect((await rest.readMessages(query(topic, { text: 'NOTE-X' }))).messages).toHaveLength(1);
    expect(await rest.sampleFormat(topic)).toBe('Avro · v2');
    // Without a registry the session still sees the wire format.
    expect(await session.sampleFormat(topic)).toBe('Schema Registry');
    expect((await session.readMessages(query(topic))).messages[0]!.value).toMatchObject({ schemaId: latest.id, decoded: null });
  });

  it('decodes JSON Schema payloads', async (ctx) => {
    needs(ctx, 'registry');
    const topic = 'events-json';
    const { id } = await rest.schemaRegistry!.version(`${topic}-value`, 'latest');
    await rest.createTopic({ name: topic, partitions: 1, replicationFactor: 1, configs: {} });
    await eventually(async () => expect((await rest.topic(topic))?.partitionInfo[0]?.leader).toBe(1));
    const header = Buffer.alloc(5);
    header.writeInt32BE(id, 1);
    const producer = new Producer({ clientId: 'test-producer', bootstrapBrokers: [`127.0.0.1:${plainPort}`] });
    await producer.send({ messages: [{ topic, partition: 0, value: Buffer.concat([header, Buffer.from('{ "kind": "signup" }')]) }] });
    await producer.close();
    expect((await rest.readMessages(query(topic))).messages[0]!.value).toMatchObject({ schemaId: id, decoded: '{"kind":"signup"}' });
    expect(await rest.sampleFormat(topic)).toBe('JSON Schema · v1');
  });

  it('manages connectors', async (ctx) => {
    needs(ctx, 'connect');
    const connect = rest.connect!;
    const name = 'file-source';
    expect(await connect.info()).toEqual({ version: '4.0.0', workers: 1 });
    expect(await connect.connectors()).toEqual([]);
    await connect.putConfig(name, { 'connector.class': 'FileStreamSource', file: '/tmp/source.txt', topic: 'connect-lines', 'tasks.max': '1' });
    const state = (expected: string) =>
      eventually(async () => {
        const [connector] = await connect.connectors();
        expect(connector?.state).toBe(expected);
        return connector!;
      }, 60_000);
    const running = await state('RUNNING');
    expect(running).toMatchObject({ name, type: 'source', className: 'FileStreamSource', trace: null, workerId: expect.stringContaining('8083') });
    await eventually(async () => expect((await connect.connectors())[0]!.tasks).toEqual([{ id: 0, state: 'RUNNING', workerId: expect.any(String), trace: null }]));
    expect((await connect.config(name))['file']).toBe('/tmp/source.txt');
    await eventually(async () => expect(values((await rest.readMessages(query('connect-lines'))).messages)).toEqual(['second line', 'first line']), 60_000);

    await connect.act(name, 'pause');
    await state('PAUSED');
    await connect.act(name, 'resume');
    await state('RUNNING');
    await connect.act(name, 'restart');
    await state('RUNNING');
    await eventually(() => connect.restartTask(name, 0), 30_000);
    await expect(connect.act(name, 'resetOffsets')).rejects.toThrow(/^Kafka Connect: .*stopped/i);
    await connect.act(name, 'stop');
    await state('STOPPED');
    await connect.act(name, 'resetOffsets');
    await connect.putConfig(name, { 'connector.class': 'FileStreamSource', file: '/tmp/source.txt', topic: 'connect-lines', 'tasks.max': '1', 'batch.size': '10' });
    expect((await connect.config(name))['batch.size']).toBe('10');
    await connect.act(name, 'delete');
    await eventually(async () => expect(await connect.connectors()).toEqual([]));
    await expect(connect.config(name)).rejects.toThrow(`Kafka Connect: Connector ${name} not found (error 404)`);
  });

  it('runs ksqlDB statements and queries, and stops a push query', async (ctx) => {
    needs(ctx, 'ksqlDb');
    const ksql = rest.ksqlDb!;
    const info = await ksql.info();
    expect(info).toMatchObject({ version: '0.29.0', tables: 0, queries: 0 });
    const noRows = { onColumns: () => {}, onRows: () => {} };
    const signal = new AbortController().signal;
    const created = await ksql.run("CREATE STREAM orders_ks (id INT, name STRING) WITH (KAFKA_TOPIC='ksql-orders', VALUE_FORMAT='JSON', PARTITIONS=1)", {}, noRows, signal);
    expect(created).toMatchObject({ kind: 'statement', text: expect.stringContaining('Stream created') });
    for (const [id, name] of [[1, 'a'], [2, 'b']] as const) await ksql.run(`INSERT INTO orders_ks (id, name) VALUES (${id}, '${name}');`, {}, noRows, signal);
    expect((await ksql.info()).streams).toBe(info.streams + 1);

    const columns: unknown[] = [];
    const rows: unknown[][] = [];
    const handlers = { onColumns: (c: unknown[]) => columns.push(...c), onRows: (r: unknown[][]) => rows.push(...r) };
    const pull = await eventually(async () => {
      rows.length = 0;
      columns.length = 0;
      const result = await ksql.run('-- every order\nSELECT * FROM orders_ks;', {}, handlers, signal);
      expect(result).toEqual({ kind: 'query', rows: 2 });
      return result;
    }, 30_000);
    expect(pull.kind).toBe('query');
    expect(columns).toEqual([
      { name: 'ID', type: 'INTEGER' },
      { name: 'NAME', type: 'STRING' },
    ]);
    expect(rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);

    const stop = new AbortController();
    const pushed: unknown[][] = [];
    const push = await ksql.run(
      'SELECT name FROM orders_ks EMIT CHANGES;',
      { 'auto.offset.reset': 'earliest' },
      {
        onColumns: () => {},
        onRows: (r) => {
          pushed.push(...r);
          if (pushed.length >= 2) stop.abort();
        },
      },
      stop.signal,
    );
    expect(push).toEqual({ kind: 'query', rows: 2 });
    expect(pushed).toEqual([['a'], ['b']]);

    await expect(ksql.run('SELECT * FROM nope;', {}, noRows, signal)).rejects.toThrow(/^ksqlDB: .*NOPE/is);
    await expect(ksql.run('DROP STREAM nope;', {}, noRows, signal)).rejects.toThrow(/^ksqlDB: .*NOPE.*\(error 40001\)$/is);
  });
});

describe('replication factor', () => {
  let broker2: StartedTestContainer;

  beforeAll(async () => {
    // A second broker that joins the controller of the first one.
    const port = await freePort();
    broker2 = await new GenericContainer(KAFKA_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('kafka2')
      .withExposedPorts({ container: 9092, host: port })
      .withEnvironment({
        CLUSTER_ID,
        KAFKA_NODE_ID: '2',
        KAFKA_PROCESS_ROLES: 'broker',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@kafka:9093',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,DOCKER://:9095',
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port},DOCKER://kafka2:9095`,
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,DOCKER:PLAINTEXT',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'DOCKER',
        ...AUTHORIZER,
      })
      .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
      .withStartupTimeout(180_000)
      .start();
    await eventually(async () => expect((await session.brokers()).map((b) => b.id)).toEqual([1, 2]), 60_000);
  });

  afterAll(async () => {
    await broker2?.stop();
  });

  it('adds replicas on the least used brokers and removes them again, keeping the leader', async () => {
    const topic = 'replicated';
    await session.createTopic({ name: topic, partitions: 2, replicationFactor: 1, configs: {} });
    const partitions = () => session.topic(topic).then((t) => t!.partitionInfo);
    await eventually(async () => expect((await partitions()).every((p) => p.leader > 0)).toBe(true));
    await session.produce(topic, [{ partition: 0, key: null, value: 'kept', headers: [] }], 'string');

    await session.changeReplicationFactor(topic, 2);
    await eventually(async () => expect((await partitions()).map((p) => [p.replicas.length, p.isr.length])).toEqual([[2, 2], [2, 2]]), 60_000);
    const leaders = (await partitions()).map((p) => p.leader);
    await session.changeReplicationFactor(topic, 1);
    await eventually(async () => expect((await partitions()).map((p) => p.replicas)).toEqual(leaders.map((l) => [l])), 60_000);
    expect(values((await session.readMessages(query(topic))).messages)).toEqual(['kept']);
    await expect(session.changeReplicationFactor(topic, 3)).rejects.toThrow('A replication factor of 3 needs 3 brokers; the cluster has 2.');
  });
});
