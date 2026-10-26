import * as assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDataSourceSettings,
  setKafkaSecurityProtocol,
  type DataSourceSettings,
  type KafkaMessageQuery,
  type KafkaWorkspaceHostMessage,
  type KafkaWorkspaceWebviewMessage,
  type KafkaWrite,
} from '@datakit/core';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ExplorerNode } from '../../src/explorer/nodes';
import { listedDataSources } from './tree';

// Needs Kafka, Schema Registry and Kafka Connect from docker/docker-compose.yml (ports 39092, 39094, 38081, 38083).
// Topics get a fresh suffix per run, since the broker keeps them between runs.

type Reply<T extends KafkaWorkspaceHostMessage['type']> = Extract<KafkaWorkspaceHostMessage, { type: T }>;

const RUN = Date.now().toString(36);
const TOPIC = `e2e-orders-${RUN}`;

function kafkaSettings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = { ...createDataSourceSettings('kafka'), name: 'events' };
  s.kafka.bootstrapServers = '127.0.0.1:39092';
  s.kafka.schemaRegistryUrl = 'http://127.0.0.1:38081';
  s.kafka.connectUrl = 'http://127.0.0.1:38083';
  patch(s);
  return s;
}

async function stubbing<T>(name: 'showSaveDialog', value: unknown, run: () => Thenable<T>): Promise<T> {
  const window = vscode.window as unknown as Record<string, unknown>;
  const original = window[name];
  window[name] = async () => value;
  try {
    return await run();
  } finally {
    window[name] = original;
  }
}

suite('Kafka workspace', () => {
  let api: TestApi;
  let id: string;

  const labelOf = (node: ExplorerNode) => {
    const label = api.tree.getTreeItem(node).label;
    return typeof label === 'string' ? label : (label?.label ?? '');
  };
  const root = async (dataSourceId = id) => (await listedDataSources(api)).find((n) => n.id === dataSourceId)!;

  /** Sends a message as the page would and waits for the first reply of one of the given types. */
  async function send<T extends KafkaWorkspaceHostMessage['type']>(message: KafkaWorkspaceWebviewMessage, ...types: T[]): Promise<Reply<T>> {
    const reply = new Promise<Reply<T>>((resolve) => {
      const listener = api.onDidPostKafka((posted) => {
        if (posted.dataSourceId !== id || !types.includes(posted.message.type as T)) return;
        listener.dispose();
        resolve(posted.message as Reply<T>);
      });
    });
    await api.sendToKafka(id, message);
    return reply;
  }

  /** Sends a write and returns its `done` or `failed` answer. */
  const write = (w: KafkaWrite) => send({ type: 'write', write: w }, 'done', 'failed');

  const query = (patch: Partial<KafkaMessageQuery> = {}): KafkaMessageQuery => ({
    topic: TOPIC,
    limit: 100,
    partition: null,
    fromOffset: null,
    toOffset: null,
    fromTime: null,
    toTime: null,
    text: null,
    ...patch,
  });

  suiteSetup(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('bakiun.datakit')!.activate())!;
    id = (await api.store.save(null, kafkaSettings(), {})).id;
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const d of api.store.list()) {
      await api.sessions.disconnect(d.id);
      await api.store.delete(d.id);
    }
  });

  test('the tree lists the workspace sections with counts', async () => {
    const node = await root();
    const sections = await api.tree.getChildren(node);
    assert.equal(api.tree.getTreeItem(node).contextValue, 'dataSource.connected.kafka');
    assert.equal(api.tree.getTreeItem(node).description, 'kafka 4.0');
    assert.deepEqual(sections.map(labelOf), ['Overview', 'Brokers', 'Topics', 'Consumers', 'ACLs', 'Schema Registry', 'Kafka Connect']);
    assert.equal(api.tree.getTreeItem(sections[1]!).description, '1');
  });

  test('a wrong SASL password shows the server error under the data source', async () => {
    const sasl = await api.store.save(
      null,
      kafkaSettings((s) => {
        s.name = 'events-sasl';
        s.kafka.bootstrapServers = '127.0.0.1:39094';
        setKafkaSecurityProtocol(s, 'SASL_PLAINTEXT');
        s.user = 'app';
      }),
      { password: 'wrong' },
    );
    const children = await api.tree.getChildren(await root(sasl.id));
    assert.equal(api.sessions.status(sasl.id), 'failed');
    assert.match(labelOf(children[0]!), /authentication/i);

    await api.store.save(sasl.id, api.store.get(sasl.id)!, { password: 'datakit' });
    await api.sessions.reconnect(sasl.id);
    assert.equal(api.sessions.status(sasl.id), 'connected');
  });

  test('a double-click on a section opens the workspace there', async () => {
    const topics = (await api.tree.getChildren(await root())).find((n) => labelOf(n) === 'Topics')!;
    const command = api.tree.getTreeItem(topics).command!;
    const init = new Promise<Reply<'init'>>((resolve) => {
      const listener = api.onDidPostKafka(({ message }) => message.type === 'init' && (listener.dispose(), resolve(message)));
    });
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
    const { init: started } = await init;
    assert.equal(started.section, 'topics');
    assert.equal(started.serverLabel, 'Kafka 4.0');
    assert.equal(started.securityProtocol, 'PLAINTEXT');
    assert.equal(started.schemaRegistryUrl, 'http://127.0.0.1:38081');
    assert.equal(started.ksqlDbUrl, null);
  });

  test('creates a topic, produces to it and reads the messages back', async () => {
    const created = await write({ kind: 'createTopic', spec: { name: TOPIC, partitions: 3, replicationFactor: 1, configs: { 'retention.ms': '86400000' } }, cloneOf: null });
    assert.deepEqual(created, { type: 'done', kind: 'createTopic', message: `Created ${TOPIC}.` });
    const duplicate = await write({ kind: 'createTopic', spec: { name: TOPIC, partitions: 1, replicationFactor: 1, configs: {} }, cloneOf: null });
    assert.equal(duplicate.type, 'failed');

    const topics = await send({ type: 'load', what: 'topics' }, 'topics');
    const summary = topics.topics.find((t) => t.name === TOPIC);
    assert.ok(summary, 'the new topic is listed');
    assert.equal(summary.partitions, 3);
    assert.equal(summary.retentionMs, 86_400_000);

    const produced = send({ type: 'write', write: { kind: 'produce', topic: TOPIC, template: { partition: null, key: 'order-${counter}', value: '{"id": ${counter}}', headers: 'source=e2e', count: 5, valueFormat: 'json' } } }, 'produced');
    assert.equal((await produced).count, 5);

    const page = await send({ type: 'messages', requestId: 1, query: query() }, 'messages');
    assert.equal(page.page.messages.length, 5);
    assert.deepEqual(page.page.messages.map((m) => m.key?.text).sort(), ['order-1', 'order-2', 'order-3', 'order-4', 'order-5']);
    assert.deepEqual(page.page.messages[0]!.headers, [{ key: 'source', value: 'e2e' }]);
    const found = await send({ type: 'messages', requestId: 2, query: query({ text: '"id":4' }) }, 'messages');
    assert.deepEqual(found.page.messages.map((m) => m.value?.text), ['{"id":4}']);

    const opened = send({ type: 'openTopic', topic: TOPIC }, 'topicConfigs');
    assert.equal((await opened).configs.find((c) => c.name === 'retention.ms')?.source, 'topic');
  });

  test('streams new messages and changes topic settings', async () => {
    const page = await send({ type: 'messages', requestId: 3, query: query() }, 'messages');
    const streamed = new Promise<Reply<'streamed'>>((resolve) => {
      const listener = api.onDidPostKafka(({ message }) => message.type === 'streamed' && (listener.dispose(), resolve(message)));
    });
    await api.sendToKafka(id, { type: 'stream', topic: TOPIC, positions: page.page.positions, partition: null, text: null });
    await write({ kind: 'produce', topic: TOPIC, template: { partition: 2, key: null, value: 'live', headers: '', count: 1, valueFormat: 'string' } });
    const { messages } = await streamed;
    await api.sendToKafka(id, { type: 'stopStream' });
    assert.deepEqual(messages.map((m) => [m.partition, m.value?.text, m.key]), [[2, 'live', null]]);

    assert.equal((await write({ kind: 'setTopicConfig', topic: TOPIC, name: 'retention.ms', value: '3600000' })).type, 'done');
    assert.equal((await write({ kind: 'repartition', topic: TOPIC, partitions: 4, replicationFactor: 1 })).type, 'done');
    const detail = await send({ type: 'openTopic', topic: TOPIC }, 'topic');
    assert.equal(detail.detail.partitions, 4);
  });

  test('dumps a topic to a JSON Lines file', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'datakit-kafka-')), 'orders.jsonl');
    const saved = await stubbing('showSaveDialog', vscode.Uri.file(file), () => send({ type: 'dump', topic: TOPIC }, 'notice'));
    assert.equal(saved.message, 'Saved 6 messages to orders.jsonl.');
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { value: unknown });
    assert.equal(lines.length, 6);
    // Values are written as the text they hold, so a JSON value stays a string.
    assert.ok(lines.some((l) => l.value === '{"id":1}'));
  });

  test('reads groups, ACLs, schemas and connectors', async () => {
    const groups = await send({ type: 'load', what: 'groups' }, 'groups', 'loadFailed');
    assert.equal(groups.type, 'groups');
    const acls = await send({ type: 'load', what: 'acls' }, 'acls', 'loadFailed');
    assert.equal(acls.type, 'acls');

    const subject = `${TOPIC}-value`;
    const schema = JSON.stringify({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'int' }] });
    assert.equal((await write({ kind: 'registerSchema', subject, schemaType: 'AVRO', schema })).type, 'done');
    const subjects = await send({ type: 'load', what: 'subjects' }, 'subjects');
    assert.ok(subjects.subjects.some((s) => s.name === subject && s.type === 'AVRO'));
    const incompatible = JSON.stringify({ type: 'record', name: 'Order', fields: [{ name: 'id', type: 'string' }] });
    const refused = await write({ kind: 'registerSchema', subject, schemaType: 'AVRO', schema: incompatible });
    assert.equal(refused.type, 'failed');
    assert.match(refused.message, /^Not compatible with the latest version/);

    const connectors = await send({ type: 'load', what: 'connectors' }, 'connectors', 'loadFailed');
    assert.equal(connectors.type, 'connectors');
  });

  test('a read-only data source refuses writes', async () => {
    const dataSource = api.store.get(id)!;
    await api.store.save(id, { ...dataSource, options: { ...dataSource.options, readOnly: true } }, {});
    try {
      assert.deepEqual(await write({ kind: 'deleteTopic', topic: TOPIC }), { type: 'failed', kind: 'deleteTopic', message: 'The data source is read-only.' });
    } finally {
      await api.store.save(id, dataSource, {});
    }
  });

  test('deletes the topic', async () => {
    assert.deepEqual(await write({ kind: 'deleteTopic', topic: TOPIC }), { type: 'done', kind: 'deleteTopic', message: `Deleted ${TOPIC}.` });
    assert.equal((await send({ type: 'openTopic', topic: TOPIC }, 'topicGone', 'topic')).type, 'topicGone');
  });
});
