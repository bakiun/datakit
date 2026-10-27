import {
  aclKey,
  compareOffsets,
  messageContains,
  produceProblem,
  recordOf,
  topicNameProblem,
  type Connector,
  type ConnectorState,
  type KafkaAcl,
  type KafkaBroker,
  type KafkaConfigEntry,
  type KafkaConfigSource,
  type KafkaGroupDetail,
  type KafkaGroupSummary,
  type KafkaMessage,
  type KafkaMessageQuery,
  type KafkaPartitionIssue,
  type KafkaPayload,
  type KafkaPositions,
  type KafkaTopicDetail,
  type KafkaTopicSummary,
  type KafkaWorkspaceHostMessage,
  type KafkaWorkspaceInit,
  type KafkaWorkspacePrefs,
  type KafkaWorkspaceWebviewMessage,
  type KafkaWrite,
  type SchemaCompatibility,
  type SchemaSubject,
  type SchemaType,
} from '@datakit/core';

/**
 * Plays the extension for the Kafka workspace on the dev server, with a cluster modelled on the design in memory.
 * Messages are generated from their offset, so any page or range can be read; writes change the model.
 * Query: `&readonly`, `&noservices` (no Schema Registry, Connect or ksqlDB), `&production` (with `&cancel`, every
 * write is declined in the Production confirmation), `&noauthorizer` (ACLs
 * not enforced), `&initfail`, `&section=topics&topic=orders.created` to open somewhere else.
 * A ksqlDB statement containing `fail` fails; a schema containing `INCOMPATIBLE` is refused as incompatible.
 */

type Reply = (message: KafkaWorkspaceHostMessage, delay?: number) => void;
type Format = 'json' | 'avro' | 'protobuf' | 'binary';

interface Partition {
  start: bigint;
  /** Offsets below this are generated; produced and streamed messages come after it. */
  generatedEnd: bigint;
  extra: KafkaMessage[];
  replicas: number[];
  isr: number[];
}

interface Topic {
  name: string;
  internal: boolean;
  partitions: Partition[];
  replicationFactor: number;
  overrides: Map<string, string>;
  format: Format;
  formatLabel: string;
  schemaId: number | null;
  bytesPerMessage: number;
  /** When the newest generated message was written, and the time between generated messages of a partition. */
  anchor: number;
  intervalMs: number;
  key: (n: number) => string | null;
  value: (n: number) => Record<string, unknown>;
}

interface Group {
  id: string;
  state: string;
  members: number;
  committed: Map<string, (bigint | null)[]>;
}

interface SchemaVersion {
  version: number;
  id: number;
  schema: string;
  deleted: boolean;
}

interface Subject {
  type: SchemaType;
  versions: SchemaVersion[];
  compatibility: SchemaCompatibility | null;
}

interface ConnectorModel extends Connector {
  config: Record<string, string>;
}

const BROKERS = [1, 2, 3];
const RACKS = ['eu-central-1a', 'eu-central-1b', 'eu-central-1c'];
const SCAN_BUDGET = 20_000;
const pick = <T>(list: readonly T[], n: number): T => list[((n % list.length) + list.length) % list.length]!;
const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function textPayload(text: string): KafkaPayload {
  return { text, binary: false, size: utf8(text).length, truncated: false, schemaId: null, decoded: null };
}

/** The Schema Registry wire format: a 0 byte, the schema id, then the encoded value (here: its JSON bytes). */
function schemaPayload(value: unknown, schemaId: number, decode: boolean): KafkaPayload {
  const json = JSON.stringify(value);
  const body = utf8(json);
  const bytes = new Uint8Array(5 + body.length);
  bytes[0] = 0;
  new DataView(bytes.buffer).setInt32(1, schemaId);
  bytes.set(body, 5);
  return { text: hex(bytes), binary: true, size: bytes.length, truncated: false, schemaId, decoded: decode ? json : null };
}

function binaryPayload(seed: number, length: number): KafkaPayload {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (seed * 31 + i * 97 + (i % 7) * 13) & 255;
  bytes[0] = 0;
  bytes[1] = 1;
  return { text: hex(bytes), binary: true, size: length, truncated: false, schemaId: null, decoded: null };
}

const TOPIC_CONFIGS: [name: string, value: string, doc: string][] = [
  ['cleanup.policy', 'delete', 'delete removes old segments, compact keeps the newest value of each key; both may be set.'],
  ['compression.type', 'producer', "Keeps the producer's compression, or forces one: gzip, snappy, lz4, zstd or uncompressed."],
  ['delete.retention.ms', '86400000', 'How long delete tombstones are kept on compacted topics.'],
  ['max.message.bytes', '1048588', 'The largest record batch the topic accepts.'],
  ['message.timestamp.type', 'CreateTime', 'CreateTime keeps the producer time, LogAppendTime uses the broker time.'],
  ['min.cleanable.dirty.ratio', '0.5', 'How much of the log may be uncompacted before the cleaner runs.'],
  ['min.compaction.lag.ms', '0', 'How long a message stays uncompacted at least.'],
  ['min.insync.replicas', '2', 'Replicas that must acknowledge a write sent with acks=all.'],
  ['retention.bytes', '-1', 'Size a partition can grow to before old segments are deleted; -1 is no limit.'],
  ['retention.ms', '604800000', 'How long messages are kept; -1 keeps them forever.'],
  ['segment.bytes', '1073741824', 'Size of a log segment file.'],
  ['segment.ms', '604800000', 'Time after which a segment is rolled even when it is not full.'],
  ['unclean.leader.election.enable', 'false', 'Lets an out-of-sync replica become leader, which loses data.'],
];

const BROKER_CONFIGS: [name: string, value: string | null, readOnly: boolean, doc: string, sensitive?: boolean][] = [
  ['background.threads', '10', false, 'Threads for background processing.'],
  ['follower.replication.throttled.rate', null, false, 'Replication throttle for followers, in bytes per second.'],
  ['leader.replication.throttled.rate', null, false, 'Replication throttle for leaders, in bytes per second.'],
  ['log.cleaner.threads', '1', false, 'Background threads that compact logs.'],
  ['max.connections', '2147483647', false, 'Connections the broker accepts at any time.'],
  ['message.max.bytes', '1048588', false, 'The largest record batch the broker accepts.'],
  ['num.io.threads', '8', false, 'Threads that process requests, including disk I/O.'],
  ['num.network.threads', '3', false, 'Threads that receive requests and send responses.'],
  ['num.replica.fetchers', '1', false, 'Fetcher threads that replicate from each source broker.'],
  ['ssl.keystore.password', null, false, 'The password of the key store file.', true],
  ['auto.create.topics.enable', 'false', true, 'Creates a topic when a client uses one that does not exist.'],
  ['default.replication.factor', '3', true, 'Replication factor of automatically created topics.'],
  ['log.dirs', '/var/lib/kafka/data', true, 'Directories where the log data is kept.'],
  ['num.partitions', '6', true, 'Partitions of automatically created topics.'],
  ['process.roles', 'broker,controller', true, 'The roles this node plays in KRaft mode.'],
];

export function installKafkaWorkspaceHost(reply: Reply): (message: KafkaWorkspaceWebviewMessage) => void {
  const params = new URLSearchParams(location.search);
  const readOnly = params.has('readonly');
  const services = !params.has('noservices');
  const production = params.has('production');
  const now = Date.now();

  // ---------- model ----------

  const topics = new Map<string, Topic>();

  function addTopic(spec: {
    name: string;
    partitions: number;
    messages: number;
    rf?: number;
    internal?: boolean;
    format: Format;
    formatLabel: string;
    schemaId?: number;
    bytes: number;
    retentionMs?: number;
    cleanup?: string;
    urp?: number;
    key: Topic['key'];
    value: Topic['value'];
  }): void {
    const rf = spec.rf ?? 3;
    const perPartition = Math.floor(spec.messages / spec.partitions);
    const partitions: Partition[] = [];
    for (let p = 0; p < spec.partitions; p++) {
      const start = BigInt(spec.messages ? 1000 * p + (p * 7919) % 500 : 0);
      const replicas = Array.from({ length: rf }, (_, k) => BROKERS[(p + k) % BROKERS.length]!);
      const isr = spec.urp === p ? replicas.filter((r) => r !== 2) : [...replicas];
      partitions.push({ start, generatedEnd: start + BigInt(perPartition ? perPartition + ((p * 1931) % 400) : 0), extra: [], replicas, isr });
    }
    const overrides = new Map<string, string>();
    if (spec.retentionMs !== undefined) overrides.set('retention.ms', String(spec.retentionMs));
    if (spec.cleanup) overrides.set('cleanup.policy', spec.cleanup);
    const span = Math.min(spec.retentionMs && spec.retentionMs > 0 ? spec.retentionMs : 30 * 86_400_000, 30 * 86_400_000);
    topics.set(spec.name, {
      name: spec.name,
      internal: !!spec.internal,
      partitions,
      replicationFactor: rf,
      overrides,
      format: spec.format,
      formatLabel: spec.formatLabel,
      schemaId: spec.schemaId ?? null,
      bytesPerMessage: spec.messages ? spec.bytes / spec.messages : 400,
      anchor: now - 4000,
      intervalMs: Math.max(50, Math.floor(span / Math.max(1, perPartition))),
      key: spec.key,
      value: spec.value,
    });
  }

  const customers = ['alice.k', 'm.young', 'p.novak', 'emily.carter', 'l.rossi', 'hana.sato'];
  addTopic({
    name: 'orders.created',
    partitions: 6,
    messages: 1_204_380,
    format: 'json',
    formatLabel: 'JSON',
    bytes: 742 * 1024 ** 2,
    retentionMs: 604_800_000,
    key: (n) => `order-${n}`,
    value: (n) => ({ order_id: n, customer: `${pick(customers, Math.floor(n / 7))}@example.com`, total: Math.round(((n * 7919) % 300000) + 990) / 100, currency: pick(['TRY', 'EUR', 'USD'], n) }),
  });
  addTopic({
    name: 'orders.status-changed',
    partitions: 6,
    messages: 3_018_442,
    format: 'json',
    formatLabel: 'JSON',
    bytes: 1.1 * 1024 ** 3,
    retentionMs: 604_800_000,
    key: (n) => `order-${n >> 1}`,
    value: (n) => ({ order_id: n >> 1, from: pick(['pending', 'paid', 'shipped'], n), to: pick(['paid', 'shipped', 'delivered'], n), at: new Date(now - n * 1000).toISOString() }),
  });
  addTopic({
    name: 'payments.captured',
    partitions: 12,
    messages: 1_187_901,
    format: 'avro',
    formatLabel: 'Avro · v4',
    schemaId: 112,
    bytes: 690 * 1024 ** 2,
    retentionMs: 2_592_000_000,
    urp: 7,
    key: (n) => `pay_${n}`,
    value: (n) => ({ payment_id: `pay_${n}`, order_id: n % 100000, amount: Math.round(((n * 6113) % 200000) + 1900) / 100, method: pick(['card', 'card', 'transfer'], n), captured_at: now - n }),
  });
  addTopic({
    name: 'inventory.adjusted',
    partitions: 3,
    messages: 402_116,
    format: 'protobuf',
    formatLabel: 'Protobuf',
    schemaId: 140,
    bytes: 96 * 1024 ** 2,
    cleanup: 'compact',
    key: (n) => `TS-${1000 + ((n * 37) % 900)}`,
    value: (n) => ({ sku: `TS-${1000 + ((n * 37) % 900)}`, delta: (n % 3) - 2, warehouse: pick(['IST-1', 'IST-2', 'ANK-1'], n) }),
  });
  addTopic({
    name: 'emails.outbox',
    partitions: 2,
    messages: 88_530,
    format: 'json',
    formatLabel: 'JSON',
    bytes: 41 * 1024 ** 2,
    retentionMs: 259_200_000,
    key: (n) => `mail-${n}`,
    value: (n) => ({ to: `${pick(customers, Math.floor(n / 3))}@example.com`, template: pick(['order_shipped', 'receipt', 'password_reset'], n), locale: pick(['tr-TR', 'en-GB', 'de-DE'], n) }),
  });
  addTopic({
    name: '__consumer_offsets',
    partitions: 50,
    messages: 41_200,
    internal: true,
    format: 'binary',
    formatLabel: 'Binary',
    bytes: 18 * 1024 ** 2,
    cleanup: 'compact',
    key: () => null,
    value: () => ({}),
  });

  const brokerOverrides = new Map<number, Map<string, string>>([[2, new Map([['num.io.threads', '16']])]]);
  const clusterDefaults = new Map([['log.cleaner.threads', '2']]);

  const end = (p: Partition) => p.generatedEnd + BigInt(p.extra.length);
  const count = (t: Topic) => t.partitions.reduce((n, p) => n + Number(end(p) - p.start), 0);

  function payloads(t: Topic, n: number, partition: number): Pick<KafkaMessage, 'key' | 'value' | 'headers'> {
    const key = t.key(n);
    const headers = t.internal ? [] : [{ key: 'trace-id', value: ((n + 7) * 2654435761 >>> 0).toString(16).padStart(8, '0') }, { key: 'source', value: pick(['checkout', 'admin', 'batch'], n) }];
    if (t.format === 'binary') return { key: binaryPayload(n, 18), value: binaryPayload(n + partition, 42), headers };
    const value = t.value(n);
    const payload = t.format === 'json' ? textPayload(JSON.stringify(value)) : schemaPayload(value, t.schemaId ?? 1, services);
    return { key: key === null ? null : textPayload(key), value: payload, headers };
  }

  function messageAt(t: Topic, partition: number, offset: bigint): KafkaMessage | null {
    const p = t.partitions[partition]!;
    if (offset < p.start || offset >= end(p)) return null;
    if (offset >= p.generatedEnd) return p.extra[Number(offset - p.generatedEnd)]!;
    const n = Number(offset) * t.partitions.length + partition;
    return { partition, offset: offset.toString(), timestamp: t.anchor - Number(p.generatedEnd - 1n - offset) * t.intervalMs - partition * 137, ...payloads(t, n, partition) };
  }

  /** The first offset of the partition written at or after `time`. */
  function offsetForTime(t: Topic, partition: number, time: number): bigint {
    const p = t.partitions[partition]!;
    const extraAt = p.extra.findIndex((m) => m.timestamp >= time);
    const lastGenerated = t.anchor - partition * 137;
    if (time > lastGenerated) return extraAt < 0 ? end(p) : p.generatedEnd + BigInt(extraAt);
    const back = BigInt(Math.floor((lastGenerated - time) / t.intervalMs));
    const offset = p.generatedEnd - 1n - back;
    return offset < p.start ? p.start : offset;
  }

  function nextMessage(t: Topic, partition: number, extra: Partial<KafkaMessage> = {}): KafkaMessage {
    const p = t.partitions[partition]!;
    const offset = end(p);
    const n = Number(offset) * t.partitions.length + partition;
    const message: KafkaMessage = { partition, offset: offset.toString(), timestamp: Date.now(), ...payloads(t, n, partition), ...extra };
    p.extra.push(message);
    return message;
  }

  function summary(t: Topic): KafkaTopicSummary {
    const cleanup = t.overrides.get('cleanup.policy') ?? 'delete';
    const retention = t.overrides.get('retention.ms') ?? '604800000';
    const messages = count(t);
    return {
      name: t.name,
      internal: t.internal,
      partitions: t.partitions.length,
      replicationFactor: t.replicationFactor,
      messages,
      bytes: Math.round(messages * t.bytesPerMessage),
      retentionMs: Number(retention),
      cleanupPolicy: cleanup,
      underReplicated: t.partitions.filter((p) => p.isr.length < p.replicas.length).length,
    };
  }

  function detail(t: Topic): KafkaTopicDetail {
    return {
      ...summary(t),
      partitionInfo: t.partitions.map((p, i) => ({ partition: i, leader: p.isr[0] ?? -1, replicas: p.replicas, isr: p.isr, start: p.start.toString(), end: end(p).toString() })),
    };
  }

  function topicConfigs(t: Topic): KafkaConfigEntry[] {
    const known = new Set(TOPIC_CONFIGS.map(([name]) => name));
    const entries: KafkaConfigEntry[] = TOPIC_CONFIGS.map(([name, value, doc]) => {
      const own = t.overrides.get(name);
      const source: KafkaConfigSource = own !== undefined ? 'topic' : name === 'min.insync.replicas' ? 'cluster' : 'default';
      return { name, value: own ?? value, source, readOnly: false, sensitive: false, documentation: doc };
    });
    for (const [name, value] of t.overrides) if (!known.has(name)) entries.push({ name, value, source: 'topic', readOnly: false, sensitive: false, documentation: null });
    return entries;
  }

  function brokerList(): KafkaBroker[] {
    return BROKERS.map((id, i) => {
      let leaders = 0;
      let replicas = 0;
      let inSync = 0;
      let bytes = 0;
      for (const t of topics.values()) {
        const perPartition = count(t) * t.bytesPerMessage / Math.max(1, t.partitions.length);
        for (const p of t.partitions) {
          if (p.isr[0] === id) leaders++;
          if (p.replicas.includes(id)) {
            replicas++;
            bytes += perPartition;
            if (p.isr.includes(id)) inSync++;
          }
        }
      }
      return {
        id,
        host: `broker-${id}.internal`,
        port: 9092,
        rack: RACKS[i]!,
        controller: id === 1,
        online: true,
        leaders,
        replicas,
        inSync,
        outOfSync: replicas - inSync,
        logDirs: [{ path: '/var/lib/kafka/data', bytes: Math.round(bytes), totalBytes: 1024 ** 4, usableBytes: 1024 ** 4 - Math.round(bytes) - 200 * 1024 ** 3 }],
      };
    });
  }

  function brokerConfigs(id: number): KafkaConfigEntry[] {
    const own = brokerOverrides.get(id) ?? new Map<string, string>();
    return BROKER_CONFIGS.map(([name, value, ro, doc, sensitive]) => {
      const mine = own.get(name);
      const cluster = clusterDefaults.get(name);
      const source: KafkaConfigSource = mine !== undefined ? 'broker' : cluster !== undefined ? 'cluster' : ro ? 'static' : 'default';
      const shown = name === 'log.dirs' || name === 'process.roles' ? value : (mine ?? cluster ?? value);
      return { name, value: sensitive ? null : shown, source, readOnly: ro, sensitive: !!sensitive, documentation: doc };
    });
  }

  const groups = new Map<string, Group>();
  function addGroup(id: string, state: string, members: number, lags: Record<string, number[]>): void {
    const committed = new Map<string, (bigint | null)[]>();
    for (const [topic, list] of Object.entries(lags)) {
      const t = topics.get(topic)!;
      committed.set(
        topic,
        t.partitions.map((p, i) => (list[i] === undefined ? null : end(p) - BigInt(list[i]!))),
      );
    }
    groups.set(id, { id, state, members, committed });
  }
  addGroup('order-service', 'Stable', 2, { 'orders.created': [2, 0, 5, 0, 3, 2], 'orders.status-changed': [0, 0, 1, 0, 0, 0] });
  addGroup('analytics-sink', 'Stable', 2, { 'orders.created': [0, 0, 0, 0, 0, 0], 'payments.captured': [0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0] });
  addGroup('notifier', 'Empty', 0, { 'emails.outbox': [23, 18] });
  addGroup('audit-replay', 'Empty', 0, { 'orders.created': [12, 0, 4, 0, 0, 3], 'payments.captured': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
  addGroup('inventory-worker', 'PreparingRebalance', 1, { 'inventory.adjusted': [1, 0, 2] });

  function groupOffsets(g: Group): KafkaGroupDetail['offsets'] {
    const rows: KafkaGroupDetail['offsets'] = [];
    for (const [topic, list] of g.committed) {
      const t = topics.get(topic);
      if (!t) continue;
      list.forEach((committed, partition) => {
        const p = t.partitions[partition];
        if (!p) return;
        const e = end(p);
        rows.push({ topic, partition, committed: committed === null ? null : committed.toString(), start: p.start.toString(), end: e.toString(), lag: committed === null ? null : Number(e - committed) });
      });
    }
    return rows;
  }

  function groupSummary(g: Group): KafkaGroupSummary {
    const lagByTopic: Record<string, number | null> = {};
    for (const o of groupOffsets(g)) lagByTopic[o.topic] = (lagByTopic[o.topic] ?? 0) + (o.lag ?? 0);
    return { id: g.id, state: g.state, protocolType: 'consumer', members: g.members, lagByTopic };
  }

  function groupDetail(g: Group): KafkaGroupDetail {
    const offsets = groupOffsets(g);
    const memberDetails = Array.from({ length: g.members }, (_, i) => ({
      id: `${g.id}-${i + 1}-5c1d9a`,
      clientId: `${g.id}-${i + 1}`,
      host: `/10.0.4.${30 + i}`,
      assignments: offsets.filter((_, j) => j % g.members === i).map((o) => ({ topic: o.topic, partition: o.partition })),
    }));
    return { ...groupSummary(g), offsets, memberDetails };
  }

  const aclRow = (principal: string, resourceType: KafkaAcl['resourceType'], resourceName: string, patternType: KafkaAcl['patternType'], operation: KafkaAcl['operation'], permission: KafkaAcl['permission'] = 'ALLOW'): KafkaAcl => ({
    principal,
    host: '*',
    resourceType,
    resourceName,
    patternType,
    operation,
    permission,
  });
  let acls: KafkaAcl[] = [
    aclRow('User:order-service', 'TOPIC', 'orders.', 'PREFIXED', 'WRITE'),
    aclRow('User:order-service', 'GROUP', 'order-service', 'LITERAL', 'READ'),
    aclRow('User:order-service', 'TOPIC', 'orders.', 'PREFIXED', 'READ'),
    aclRow('User:analytics', 'TOPIC', '*', 'LITERAL', 'READ'),
    aclRow('User:analytics', 'GROUP', 'analytics-sink', 'LITERAL', 'READ'),
    aclRow('User:payment-gw', 'TOPIC', 'payments.captured', 'LITERAL', 'WRITE'),
    aclRow('User:payment-gw', 'CLUSTER', 'kafka-cluster', 'LITERAL', 'IDEMPOTENT_WRITE'),
    aclRow('User:notifier', 'TOPIC', 'emails.outbox', 'LITERAL', 'READ'),
    aclRow('User:notifier', 'GROUP', 'notifier', 'LITERAL', 'READ'),
    aclRow('User:quarry-reader', 'TOPIC', '*', 'LITERAL', 'DESCRIBE'),
    aclRow('User:legacy-etl', 'TOPIC', 'orders.created', 'LITERAL', 'WRITE', 'DENY'),
  ];

  let globalCompatibility: SchemaCompatibility = 'BACKWARD';
  let schemaId = 150;
  const paymentSchema = (v: number) =>
    JSON.stringify({
      type: 'record',
      name: 'PaymentCaptured',
      namespace: 'shop.payments',
      fields: [
        { name: 'payment_id', type: 'string' },
        { name: 'order_id', type: 'long' },
        { name: 'amount', type: { type: 'bytes', logicalType: 'decimal', precision: 12, scale: 2 } },
        ...(v >= 3 ? [{ name: 'method', type: { type: 'enum', name: 'Method', symbols: ['card', 'transfer'] } }] : []),
        ...(v >= 4 ? [{ name: 'captured_at', type: ['null', 'long'], default: null }] : []),
      ],
    });
  const orderSchema = (v: number) =>
    JSON.stringify({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'OrderCreated',
      type: 'object',
      required: ['order_id', 'total'],
      properties: { order_id: { type: 'integer' }, customer: { type: 'string' }, total: { type: 'number' }, ...(v >= 2 ? { currency: { type: 'string', enum: ['TRY', 'EUR', 'USD'] } } : {}) },
    });
  const subjects = new Map<string, Subject>([
    ['payments.captured-value', { type: 'AVRO', compatibility: null, versions: [1, 2, 3, 4].map((v) => ({ version: v, id: 108 + v, schema: paymentSchema(v), deleted: false })) }],
    ['orders.created-value', { type: 'JSON', compatibility: 'FULL', versions: [1, 2].map((v) => ({ version: v, id: 85 + v, schema: orderSchema(v), deleted: false })) }],
    [
      'inventory.adjusted-value',
      {
        type: 'PROTOBUF',
        compatibility: null,
        versions: [{ version: 1, id: 140, deleted: false, schema: 'syntax = "proto3";\npackage shop.inventory;\n\nmessage InventoryAdjusted {\n  string sku = 1;\n  int32 delta = 2;\n  string warehouse = 3;\n}\n' }],
      },
    ],
  ]);
  const liveVersions = (s: Subject) => s.versions.filter((v) => !v.deleted);

  const task = (id: number, state: ConnectorState, trace: string | null = null) => ({ id, state, workerId: `connect-${(id % 2) + 1}.internal:8083`, trace });
  const seedConnectors: ConnectorModel[] = [
      {
        name: 's3-sink-orders',
        type: 'sink',
        className: 'io.confluent.connect.s3.S3SinkConnector',
        state: 'RUNNING',
        workerId: 'connect-1.internal:8083',
        trace: null,
        tasks: [task(0, 'RUNNING'), task(1, 'RUNNING'), task(2, 'RUNNING')],
        config: { 'connector.class': 'io.confluent.connect.s3.S3SinkConnector', 'tasks.max': '3', topics: 'orders.created', 's3.bucket.name': 'shop-orders-archive', 'flush.size': '1000' },
      },
      {
        name: 'debezium-shop-mysql',
        type: 'source',
        className: 'io.debezium.connector.mysql.MySqlConnector',
        state: 'RUNNING',
        workerId: 'connect-2.internal:8083',
        trace: null,
        tasks: [task(0, 'RUNNING')],
        config: { 'connector.class': 'io.debezium.connector.mysql.MySqlConnector', 'tasks.max': '1', 'database.hostname': 'mysql.internal', 'database.port': '3306', 'topic.prefix': 'shop' },
      },
      {
        name: 'es-sink-catalog',
        type: 'sink',
        className: 'io.confluent.connect.elasticsearch.ElasticsearchSinkConnector',
        state: 'RUNNING',
        workerId: 'connect-1.internal:8083',
        trace: null,
        tasks: [
          task(0, 'RUNNING'),
          task(1, 'FAILED', 'org.apache.kafka.connect.errors.ConnectException: Elasticsearch returned 429 Too Many Requests\n\tat io.confluent.connect.elasticsearch.ElasticsearchClient.handleResponse(ElasticsearchClient.java:410)'),
        ],
        config: { 'connector.class': 'io.confluent.connect.elasticsearch.ElasticsearchSinkConnector', 'tasks.max': '2', topics: 'inventory.adjusted', 'connection.url': 'http://es.internal:9200' },
      },
      {
        name: 'jdbc-sink-analytics',
        type: 'sink',
        className: 'io.confluent.connect.jdbc.JdbcSinkConnector',
        state: 'PAUSED',
        workerId: 'connect-2.internal:8083',
        trace: null,
        tasks: [task(0, 'PAUSED'), task(1, 'PAUSED')],
        config: { 'connector.class': 'io.confluent.connect.jdbc.JdbcSinkConnector', 'tasks.max': '2', topics: 'payments.captured', 'connection.url': 'jdbc:postgresql://analytics.internal:5432/shop' },
      },
  ];
  const connectors = new Map(seedConnectors.map((c) => [c.name, c]));
  const connectorList = (): Connector[] => [...connectors.values()].map(({ config: _config, ...c }) => c);

  let favourites = ['orders.created', 'payments.captured'];
  /** Remembered choices; kept in sessionStorage so a reload of the dev page shows them coming back. */
  const prefsKey = 'datakit.dev.kafkaPrefs';
  const readPrefs = (): KafkaWorkspacePrefs => {
    try {
      return JSON.parse(sessionStorage.getItem(prefsKey) ?? '{}') as KafkaWorkspacePrefs;
    } catch {
      return {};
    }
  };

  // ---------- reads ----------

  function overview(): KafkaWorkspaceHostMessage {
    const visible = [...topics.values()].filter((t) => !t.internal);
    const issues: KafkaPartitionIssue[] = [];
    for (const t of topics.values()) t.partitions.forEach((p, i) => p.isr.length < p.replicas.length && issues.push({ topic: t.name, partition: i, leader: p.isr[0] ?? -1, replicas: p.replicas, isr: p.isr }));
    return {
      type: 'overview',
      overview: {
        clusterId: 'q7Xk2mVhR3a1Lq9Zr0n2Wg',
        controllerId: 1,
        brokers: brokerList(),
        topics: visible.length,
        partitions: visible.reduce((n, t) => n + t.partitions.length, 0),
        replicationFactors: [...new Set(visible.map((t) => t.replicationFactor))].sort((a, b) => a - b),
        underReplicated: issues,
        offline: [],
        groups: [...groups.values()].map(groupSummary),
        checkedAt: Date.now(),
      },
      connectors: services ? connectorList() : null,
      subjects: services ? [...subjects.values()].filter((s) => liveVersions(s).length).length : null,
      globalCompatibility: services ? globalCompatibility : null,
    };
  }

  function readMessages(query: KafkaMessageQuery): { messages: KafkaMessage[]; scanned: number; partial: boolean; positions: KafkaPositions } {
    const t = topics.get(query.topic)!;
    const positions: KafkaPositions = {};
    t.partitions.forEach((p, i) => (positions[String(i)] = end(p).toString()));
    const found: KafkaMessage[] = [];
    let scanned = 0;
    let partial = false;
    const partitions = query.partition === null ? t.partitions.map((_, i) => i) : [query.partition];
    const budget = Math.floor(SCAN_BUDGET / partitions.length);
    for (const i of partitions) {
      const p = t.partitions[i]!;
      let high = end(p) - 1n;
      let low = p.start;
      if (query.toOffset !== null && BigInt(query.toOffset) < high) high = BigInt(query.toOffset);
      if (query.fromOffset !== null && BigInt(query.fromOffset) > low) low = BigInt(query.fromOffset);
      if (query.toTime !== null) {
        const before = offsetForTime(t, i, query.toTime + 1) - 1n;
        if (before < high) high = before;
      }
      if (query.fromTime !== null) {
        const from = offsetForTime(t, i, query.fromTime);
        if (from > low) low = from;
      }
      let matched = 0;
      let read = 0;
      for (let offset = high; offset >= low && matched < query.limit; offset--) {
        if (read >= budget) {
          partial = true;
          break;
        }
        const m = messageAt(t, i, offset);
        read++;
        if (!m) continue;
        if (query.fromTime !== null && m.timestamp < query.fromTime) continue;
        if (query.toTime !== null && m.timestamp > query.toTime) continue;
        if (query.text !== null && !messageContains(m, query.text)) continue;
        found.push(m);
        matched++;
      }
      scanned += read;
    }
    found.sort((a, b) => b.timestamp - a.timestamp || compareOffsets(b.offset, a.offset));
    return { messages: found.slice(0, query.limit), scanned, partial: partial && query.text !== null, positions };
  }

  function schemaDetail(name: string, version: number | 'latest') {
    const s = subjects.get(name);
    const live = s ? liveVersions(s) : [];
    const v = version === 'latest' ? live[live.length - 1] : live.find((x) => x.version === version);
    if (!s || !v) return null;
    return { subject: name, version: v.version, id: v.id, type: s.type, schema: v.schema, versions: live.map((x) => x.version), compatibility: s.compatibility };
  }

  // ---------- streaming ----------

  let stream: { topic: string; positions: KafkaPositions; partition: number | null; text: string | null; timer: ReturnType<typeof setInterval>; tick: number } | null = null;

  function stopStream(message: string | null = null): void {
    if (!stream) return;
    clearInterval(stream.timer);
    const topic = stream.topic;
    stream = null;
    if (message) reply({ type: 'streamStopped', topic, message });
  }

  /** Sends what arrived after the stream's positions and matches its filter. */
  function flushStream(): void {
    if (!stream) return;
    const t = topics.get(stream.topic);
    if (!t) return stopStream('The topic was deleted.');
    const out: KafkaMessage[] = [];
    t.partitions.forEach((p, i) => {
      const at = BigInt(stream!.positions[String(i)] ?? end(p).toString());
      for (let offset = at < p.start ? p.start : at; offset < end(p); offset++) {
        const m = messageAt(t, i, offset)!;
        if ((stream!.partition === null || stream!.partition === i) && (stream!.text === null || messageContains(m, stream!.text))) out.push(m);
      }
      stream!.positions[String(i)] = end(p).toString();
    });
    if (out.length) reply({ type: 'streamed', topic: t.name, messages: out.sort((a, b) => b.timestamp - a.timestamp) });
  }

  function startStream(message: Extract<KafkaWorkspaceWebviewMessage, { type: 'stream' }>): void {
    stopStream();
    const timer = setInterval(() => {
      const s = stream;
      const t = s && topics.get(s.topic);
      if (!s || !t) return stopStream('The topic was deleted.');
      s.tick++;
      const partition = s.partition ?? Math.floor(Math.random() * t.partitions.length);
      const m = nextMessage(t, partition);
      // Every other message carries the searched text, so a text filter finds something.
      if (s.text && s.tick % 2 === 0 && m.value && !m.value.binary) {
        const value = { ...(JSON.parse(m.value.text) as Record<string, unknown>), note: s.text };
        m.value = textPayload(JSON.stringify(value));
      }
      flushStream();
    }, 2000);
    stream = { topic: message.topic, positions: { ...message.positions }, partition: message.partition, text: message.text, timer, tick: 0 };
  }

  // ---------- ksqlDB ----------

  let ksqlRun: { runId: number; timer: ReturnType<typeof setInterval> | null } | null = null;

  function stopKsql(): void {
    if (ksqlRun?.timer) clearInterval(ksqlRun.timer);
    ksqlRun = null;
  }

  function runKsql(runId: number, statement: string, properties: Record<string, string>): void {
    stopKsql();
    const text = statement.trim();
    const started = Date.now();
    const upper = text.toUpperCase();
    if (/fail|missing/i.test(text)) {
      reply({ type: 'ksqlFailed', runId, message: "Line: 1, Col: 8: SELECT column 'MISSING' cannot be resolved." }, 200);
      return;
    }
    if (upper.startsWith('SELECT')) {
      const columns = [
        { name: 'WINDOW_START', type: 'STRING' },
        { name: 'CURRENCY', type: 'STRING' },
        { name: 'ORDERS', type: 'BIGINT' },
        { name: 'REVENUE', type: 'DOUBLE' },
      ];
      let minute = 0;
      const row = (): unknown[] => {
        minute++;
        const at = new Date(started - (20 - minute) * 60_000);
        return [at.toISOString().slice(0, 16).replace('T', ' '), pick(['TRY', 'EUR', 'USD'], minute), 20 + ((minute * 17) % 30), Math.round(((minute * 7919) % 5_000_000) + 100_000) / 100];
      };
      reply({ type: 'ksqlColumns', runId, columns }, 150);
      const first = properties['auto.offset.reset'] === 'earliest' ? 12 : 3;
      reply({ type: 'ksqlRows', runId, rows: Array.from({ length: first }, row) }, 300);
      if (!/EMIT\s+CHANGES/.test(upper)) {
        reply({ type: 'ksqlDone', runId, result: { kind: 'query', rows: first }, durationMs: 240 }, 350);
        return;
      }
      const timer = setInterval(() => reply({ type: 'ksqlRows', runId, rows: [row()] }), 1500);
      ksqlRun = { runId, timer };
      return;
    }
    if (readOnly && !/^(SHOW|LIST|DESCRIBE|EXPLAIN|PRINT)\b/.test(upper)) {
      reply({ type: 'ksqlFailed', runId, message: 'This data source is read-only.' }, 100);
      return;
    }
    let result: unknown;
    if (/^(SHOW|LIST)\s+STREAMS/.test(upper)) {
      result = [{ '@type': 'streams', statementText: text, streams: ['orders_stream', 'payments_stream', 'inventory_stream', 'emails_stream'].map((name) => ({ type: 'STREAM', name: name.toUpperCase(), topic: name.replace('_stream', ''), keyFormat: 'KAFKA', valueFormat: 'JSON' })) }];
    } else if (/^(SHOW|LIST)\s+TABLES/.test(upper)) {
      result = [{ '@type': 'tables', statementText: text, tables: [{ type: 'TABLE', name: 'REVENUE_PER_MINUTE', topic: 'REVENUE_PER_MINUTE', isWindowed: true }, { type: 'TABLE', name: 'STOCK_LEVELS', topic: 'STOCK_LEVELS', isWindowed: false }] }];
    } else if (/^(SHOW|LIST)\s+QUERIES/.test(upper)) {
      result = [{ '@type': 'queries', statementText: text, queries: [{ id: 'CTAS_REVENUE_PER_MINUTE_3', state: 'RUNNING' }, { id: 'CTAS_STOCK_LEVELS_5', state: 'RUNNING' }, { id: 'CSAS_ORDERS_EU_7', state: 'RUNNING' }] }];
    } else {
      result = [{ '@type': 'currentStatus', statementText: text, commandStatus: { status: 'SUCCESS', message: 'Statement written to command topic' }, commandSequenceNumber: 42 }];
    }
    reply({ type: 'ksqlDone', runId, result: { kind: 'statement', text: JSON.stringify(result, null, 2) }, durationMs: 85 }, 250);
  }

  // ---------- writes ----------

  /** Applies a write; returns the done message, or throws with the failure. */
  function apply(w: KafkaWrite): string {
    if (readOnly) throw new Error('This data source is read-only.');
    const topicOf = (name: string) => {
      const t = topics.get(name);
      if (!t) throw new Error(`Topic ${name} does not exist.`);
      return t;
    };
    switch (w.kind) {
      case 'setBrokerConfig': {
        const own = brokerOverrides.get(w.brokerId) ?? new Map<string, string>();
        brokerOverrides.set(w.brokerId, own);
        if (w.value === null) {
          own.delete(w.name);
          return `Removed the override of ${w.name} on broker-${w.brokerId}.`;
        }
        if (/threads|max/.test(w.name) && !/^\d+$/.test(w.value)) throw new Error(`Invalid value ${w.value} for configuration ${w.name}: Not a number of type INT`);
        own.set(w.name, w.value);
        return `Updated ${w.name} on broker-${w.brokerId}: applied live.`;
      }
      case 'createTopic': {
        const problem = topicNameProblem(w.spec.name, [...topics.keys()]);
        if (problem === 'This topic already exists.') throw new Error(`Topic '${w.spec.name}' already exists.`);
        if (problem) throw new Error(problem);
        if (w.spec.replicationFactor > BROKERS.length) throw new Error(`Replication factor: ${w.spec.replicationFactor} larger than available brokers: ${BROKERS.length}.`);
        const source = w.cloneOf ? topicOf(w.cloneOf) : null;
        const partitions = Array.from({ length: w.spec.partitions }, (_, p) => {
          const replicas = Array.from({ length: w.spec.replicationFactor }, (_, k) => BROKERS[(p + k) % BROKERS.length]!);
          return { start: 0n, generatedEnd: 0n, extra: [], replicas, isr: [...replicas] };
        });
        topics.set(w.spec.name, {
          ...(source ?? topics.get('orders.created')!),
          name: w.spec.name,
          internal: false,
          partitions,
          replicationFactor: w.spec.replicationFactor,
          overrides: new Map([...(source?.overrides ?? []), ...Object.entries(w.spec.configs)]),
        });
        return w.cloneOf ? `Cloned ${w.cloneOf} as ${w.spec.name}.` : `Created ${w.spec.name}.`;
      }
      case 'deleteTopic':
        topicOf(w.topic);
        topics.delete(w.topic);
        for (const g of groups.values()) g.committed.delete(w.topic);
        favourites = favourites.filter((f) => f !== w.topic);
        reply({ type: 'favourites', names: favourites });
        if (stream?.topic === w.topic) stopStream('The topic was deleted.');
        return `Deleted ${w.topic}.`;
      case 'clearTopic': {
        const t = topicOf(w.topic);
        const before = count(t);
        for (const p of t.partitions) p.start = end(p);
        return `Cleared ${w.topic}: deleted ${before.toLocaleString('en-US')} messages.`;
      }
      case 'recreateTopic': {
        const t = topicOf(w.topic);
        t.partitions = t.partitions.map((p) => ({ ...p, start: 0n, generatedEnd: 0n, extra: [] }));
        for (const g of groups.values()) if (g.committed.has(w.topic)) g.committed.set(w.topic, t.partitions.map(() => null));
        if (stream?.topic === w.topic) stopStream('The topic was re-created.');
        return `Re-created ${w.topic}.`;
      }
      case 'repartition': {
        const t = topicOf(w.topic);
        if (w.partitions < t.partitions.length) throw new Error(`Topic currently has ${t.partitions.length} partitions, which is higher than the requested ${w.partitions}.`);
        if (w.replicationFactor > BROKERS.length) throw new Error(`Replication factor: ${w.replicationFactor} larger than available brokers: ${BROKERS.length}.`);
        for (let p = t.partitions.length; p < w.partitions; p++) {
          const replicas = Array.from({ length: t.replicationFactor }, (_, k) => BROKERS[(p + k) % BROKERS.length]!);
          t.partitions.push({ start: 0n, generatedEnd: 0n, extra: [], replicas, isr: [...replicas] });
        }
        const reassign = w.replicationFactor !== t.replicationFactor;
        if (reassign) {
          t.replicationFactor = w.replicationFactor;
          t.partitions.forEach((p, i) => {
            p.replicas = Array.from({ length: w.replicationFactor }, (_, k) => BROKERS[(i + k) % BROKERS.length]!);
            p.isr = [...p.replicas];
          });
        }
        return `${w.topic}: ${w.partitions} partitions, RF ${w.replicationFactor}${reassign ? ', reassignment started.' : '.'}`;
      }
      case 'setTopicConfig': {
        const t = topicOf(w.topic);
        if (w.value === null) {
          t.overrides.delete(w.name);
          return `Removed the override of ${w.name} on ${w.topic}.`;
        }
        if (/\.(ms|bytes|replicas)$/.test(w.name) && !/^-?\d+$/.test(w.value)) throw new Error(`Invalid value ${w.value} for configuration ${w.name}: Not a number of type LONG`);
        t.overrides.set(w.name, w.value);
        return `Updated ${w.name} on ${w.topic}.`;
      }
      case 'produce': {
        const t = topicOf(w.topic);
        const problem = produceProblem(w.template, t.partitions.length);
        if (problem) throw new Error(problem);
        if (w.template.valueFormat === 'avro' && !services) throw new Error('Avro values need a Schema Registry; none is configured.');
        const values = { uuid: () => crypto.randomUUID(), now: new Date(), random: Math.random };
        const results: { partition: number; offset: string }[] = [];
        const stored = Math.min(w.template.count, 5000);
        for (let i = 0; i < stored; i++) {
          const r = recordOf(w.template, i, values);
          const partition = r.partition ?? (r.key === null ? i % t.partitions.length : [...r.key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % t.partitions.length);
          const value =
            r.value === null
              ? null
              : w.template.valueFormat === 'avro'
                ? schemaPayload(JSON.parse(r.value), t.schemaId ?? 112, services)
                : textPayload(r.value);
          const m = nextMessage(t, partition, { key: r.key === null ? null : textPayload(r.key), value, headers: r.headers.map((h) => ({ key: h.key, value: h.value })), timestamp: Date.now() });
          if (results.length < 10) results.push({ partition: m.partition, offset: m.offset });
        }
        reply({ type: 'produced', topic: w.topic, count: w.template.count, results }, 20);
        return `Produced ${w.template.count.toLocaleString('en-US')} message${w.template.count === 1 ? '' : 's'} to ${w.topic}.`;
      }
      case 'resetOffsets': {
        const g = groups.get(w.groupId);
        if (!g) throw new Error(`Group ${w.groupId} does not exist.`);
        if (g.members > 0) throw new Error(`Group ${w.groupId} has active members; stop its consumers first.`);
        let moved = 0;
        for (const [topic, list] of g.committed) {
          const t = topics.get(topic)!;
          list.forEach((_, i) => {
            if (w.partitions && !w.partitions.some((x) => x.topic === topic && x.partition === i)) return;
            const p = t.partitions[i]!;
            const e = end(p);
            const target = w.target;
            let to: bigint;
            if (target.kind === 'earliest') to = p.start;
            else if (target.kind === 'latest') to = e;
            else if (target.kind === 'timestamp') to = offsetForTime(t, i, target.time);
            else to = BigInt(target.offset);
            list[i] = to < p.start ? p.start : to > e ? e : to;
            moved++;
          });
        }
        const t = w.target;
        const where = t.kind === 'timestamp' ? `the first offset after ${new Date(t.time).toLocaleString('en-GB')}` : t.kind === 'offset' ? `offset ${t.offset}` : t.kind;
        return `Moved ${moved} offsets of ${w.groupId} to ${where}.`;
      }
      case 'deleteGroup': {
        const g = groups.get(w.groupId);
        if (!g) throw new Error(`Group ${w.groupId} does not exist.`);
        if (g.members > 0) throw new Error(`The group is not empty.`);
        groups.delete(w.groupId);
        return `Deleted group ${w.groupId}.`;
      }
      case 'createAcls': {
        const known = new Set(acls.map(aclKey));
        const fresh = w.acls.filter((a) => !known.has(aclKey(a)));
        acls = [...acls, ...fresh];
        return `Created ${fresh.length} ACL${fresh.length === 1 ? '' : 's'}${fresh.length < w.acls.length ? `; ${w.acls.length - fresh.length} existed already` : ''}.`;
      }
      case 'deleteAcls': {
        const gone = new Set(w.acls.map(aclKey));
        const before = acls.length;
        acls = acls.filter((a) => !gone.has(aclKey(a)));
        return `Deleted ${before - acls.length} ACLs.`;
      }
      case 'setGlobalCompatibility':
        if (!services) throw new Error('No Schema Registry is configured.');
        globalCompatibility = w.level;
        return `Global compatibility set to ${w.level}.`;
      case 'setCompatibility': {
        const s = subjects.get(w.subject);
        if (!s) throw new Error(`Subject ${w.subject} not found.`);
        s.compatibility = w.level;
        return `Compatibility of ${w.subject} set to ${w.level ?? 'the global level'}.`;
      }
      case 'registerSchema': {
        if (w.schemaType !== 'PROTOBUF') {
          try {
            JSON.parse(w.schema);
          } catch {
            throw new Error(`Invalid schema: ${w.schemaType} schemas are JSON.`);
          }
        }
        const s = subjects.get(w.subject) ?? { type: w.schemaType, versions: [], compatibility: null };
        if (/INCOMPATIBLE/.test(w.schema) && liveVersions(s).length) {
          throw new Error(`Schema being registered is incompatible with an earlier schema for subject "${w.subject}": READER_FIELD_MISSING_DEFAULT_VALUE (${s.compatibility ?? globalCompatibility}).`);
        }
        const version = (s.versions[s.versions.length - 1]?.version ?? 0) + 1;
        const id = ++schemaId;
        s.versions.push({ version, id, schema: w.schema, deleted: false });
        subjects.set(w.subject, s);
        return `Registered ${w.subject} version ${version} (id ${id}).`;
      }
      case 'deleteSchemaVersion': {
        const s = subjects.get(w.subject);
        const v = s?.versions.find((x) => x.version === w.version);
        if (!s || !v) throw new Error(`Version ${w.version} of ${w.subject} not found.`);
        if (w.permanent) s.versions = s.versions.filter((x) => x !== v);
        else v.deleted = true;
        if (!s.versions.some((x) => !x.deleted) && w.permanent) subjects.delete(w.subject);
        return w.permanent ? `Hard-deleted ${w.subject} version ${w.version}.` : `Soft-deleted ${w.subject} version ${w.version}. It can still be read by id.`;
      }
      case 'connector': {
        const c = connectors.get(w.name);
        if (!c) throw new Error(`Connector ${w.name} not found.`);
        const setAll = (state: ConnectorState) => {
          c.state = state;
          c.trace = null;
          c.tasks = c.tasks.map((t) => ({ ...t, state, trace: null }));
        };
        switch (w.action) {
          case 'pause':
            setAll('PAUSED');
            return `Paused ${w.name}.`;
          case 'resume':
            setAll('RUNNING');
            return `Resumed ${w.name}.`;
          case 'stop':
            setAll('STOPPED');
            return `Stopped ${w.name}.`;
          case 'restart':
            setAll('RUNNING');
            return `Restarted ${w.name} and its tasks.`;
          case 'delete':
            connectors.delete(w.name);
            return `Deleted ${w.name}.`;
          case 'resetOffsets': {
            // As the extension does: a connector that is not stopped is stopped first.
            const wasStopped = c.state === 'STOPPED';
            setAll('STOPPED');
            return wasStopped ? `Reset the offsets of ${w.name}.` : `Stopped ${w.name} and reset its offsets. Resume it to start over.`;
          }
        }
        break;
      }
      case 'restartTask': {
        const c = connectors.get(w.name);
        const t = c?.tasks.find((x) => x.id === w.task);
        if (!c || !t) throw new Error(`Task ${w.task} of ${w.name} not found.`);
        t.state = 'RUNNING';
        t.trace = null;
        return `Restarted task ${w.task} of ${w.name}.`;
      }
      case 'restartFailed': {
        let n = 0;
        for (const c of connectors.values()) {
          for (const item of [c, ...c.tasks]) {
            if (item.state !== 'FAILED') continue;
            item.state = 'RUNNING';
            item.trace = null;
            n++;
          }
        }
        return n ? `Restarted ${n} failed task${n === 1 ? '' : 's'}.` : 'Nothing had failed.';
      }
      case 'saveConnector': {
        const className = w.config['connector.class'];
        if (!className) throw new Error(`Connector config ${JSON.stringify(w.config)} contains no connector type`);
        const old = connectors.get(w.name);
        const tasks = Math.max(1, Number(w.config['tasks.max'] ?? '1') || 1);
        connectors.set(w.name, {
          name: w.name,
          type: /sink/i.test(className) ? 'sink' : /source|debezium/i.test(className) ? 'source' : 'unknown',
          className,
          state: 'RUNNING',
          workerId: 'connect-1.internal:8083',
          trace: null,
          tasks: Array.from({ length: tasks }, (_, i) => task(i, 'RUNNING')),
          config: { ...w.config },
        });
        return old ? `Saved the config of ${w.name}; its tasks restart.` : `Created ${w.name}.`;
      }
    }
    return 'Done.';
  }

  // ---------- messages from the page ----------

  const init = (): KafkaWorkspaceInit => ({
    dataSourceName: 'events',
    environment: production ? 'production' : 'staging',
    serverLabel: 'Kafka 3.7',
    securityProtocol: 'SASL_SSL',
    bootstrapServers: BROKERS.map((id) => `broker-${id}.internal:9092`).join(','),
    readOnly,
    pageSize: 100,
    schemaRegistryUrl: services ? 'http://schema-registry.internal:8081' : null,
    connectUrl: services ? 'http://connect.internal:8083' : null,
    ksqlDbUrl: services ? 'http://ksqldb.internal:8088' : null,
    favourites,
    prefs: readPrefs(),
    section: (params.get('section') as KafkaWorkspaceInit['section'] | null) ?? 'overview',
    topic: params.get('topic'),
  });

  const missing = (what: 'subjects' | 'connectors' | 'ksqlInfo') =>
    reply({ type: 'loadFailed', what, message: `No ${what === 'subjects' ? 'Schema Registry' : what === 'connectors' ? 'Kafka Connect' : 'ksqlDB'} URL is configured.` }, 100);

  return (message) => {
    switch (message.type) {
      case 'ready':
        if (params.has('initfail')) reply({ type: 'initFailed', message: 'Could not connect to broker-1.internal:9092: SASL authentication failed.' }, 400);
        else reply({ type: 'init', init: init() }, 200);
        break;
      case 'load':
        switch (message.what) {
          case 'overview':
            reply(overview(), 350);
            break;
          case 'brokers':
            reply({ type: 'brokers', brokers: brokerList() }, 200);
            break;
          case 'topics': {
            const list = [...topics.values()];
            reply({ type: 'topics', topics: list.map(summary) }, 200);
            reply({ type: 'topicFormats', formats: Object.fromEntries(list.filter((t) => count(t) > 0).map((t) => [t.name, t.formatLabel])) }, 600);
            break;
          }
          case 'groups':
            reply({ type: 'groups', groups: [...groups.values()].map(groupSummary) }, 200);
            break;
          case 'acls':
            reply({ type: 'acls', acls: params.has('noauthorizer') ? null : acls }, 200);
            break;
          case 'subjects':
            if (!services) missing('subjects');
            else
              reply(
                {
                  type: 'subjects',
                  subjects: [...subjects.entries()]
                    .filter(([, s]) => liveVersions(s).length)
                    .map(([name, s]): SchemaSubject => ({ name, type: s.type, latestVersion: liveVersions(s).at(-1)!.version, latestId: liveVersions(s).at(-1)!.id })),
                  globalCompatibility,
                },
                200,
              );
            break;
          case 'connectors':
            if (!services) missing('connectors');
            else reply({ type: 'connectors', connectors: connectorList(), workers: 2, version: '3.7.1' }, 250);
            break;
          case 'ksqlInfo':
            if (!services) missing('ksqlInfo');
            else reply({ type: 'ksqlInfo', info: { version: '0.29.0', streams: 4, tables: 2, queries: 3 } }, 200);
            break;
        }
        break;
      case 'brokerConfigs':
        reply({ type: 'brokerConfigs', brokerId: message.brokerId, configs: brokerConfigs(message.brokerId) }, 200);
        break;
      case 'openTopic': {
        const t = topics.get(message.topic);
        if (!t) reply({ type: 'topicGone', topic: message.topic }, 100);
        else {
          reply({ type: 'topic', detail: detail(t) }, 150);
          reply({ type: 'topicConfigs', topic: t.name, configs: topicConfigs(t) }, 250);
        }
        break;
      }
      case 'messages': {
        const t = topics.get(message.query.topic);
        if (!t) {
          reply({ type: 'messagesFailed', requestId: message.requestId, message: `Topic ${message.query.topic} does not exist.` }, 100);
          break;
        }
        const started = performance.now();
        const page = readMessages(message.query);
        reply({ type: 'messages', requestId: message.requestId, topic: t.name, page, durationMs: performance.now() - started + 60 }, 250);
        break;
      }
      case 'stream':
        startStream(message);
        break;
      case 'stopStream':
        stopStream();
        break;
      case 'openGroup': {
        const g = groups.get(message.groupId);
        if (!g) reply({ type: 'groupGone', groupId: message.groupId }, 100);
        else reply({ type: 'group', detail: groupDetail(g) }, 200);
        break;
      }
      case 'schema': {
        const d = schemaDetail(message.subject, message.version);
        if (d) reply({ type: 'schema', detail: d }, 150);
        else reply({ type: 'loadFailed', what: 'schema', message: `Subject '${message.subject}' not found.` }, 100);
        break;
      }
      case 'connectorConfig': {
        const c = connectors.get(message.name);
        if (c) reply({ type: 'connectorConfig', name: c.name, config: c.config }, 200);
        else reply({ type: 'loadFailed', what: 'connectorConfig', message: `Connector ${message.name} not found.` }, 100);
        break;
      }
      case 'ksql':
        runKsql(message.runId, message.statement, message.properties);
        break;
      case 'ksqlStop':
        if (ksqlRun?.runId === message.runId) stopKsql();
        break;
      case 'write':
        // `&cancel` plays declining the Production confirmation.
        if (production && params.has('cancel')) {
          reply({ type: 'failed', kind: message.write.kind, message: 'Nothing was changed.', cancelled: true }, 300);
          break;
        }
        try {
          const done = apply(message.write);
          if (production) console.info('[dev host] production: the extension asks in a VS Code modal before', message.write.kind);
          reply({ type: 'done', kind: message.write.kind, message: done }, 300);
          if (stream) setTimeout(flushStream, 400);
        } catch (error) {
          reply({ type: 'failed', kind: message.write.kind, message: (error as Error).message }, 300);
        }
        break;
      case 'favourite':
        favourites = message.on ? [...new Set([...favourites, message.topic])] : favourites.filter((f) => f !== message.topic);
        reply({ type: 'favourites', names: favourites }, 50);
        break;
      case 'dump': {
        const t = topics.get(message.topic);
        reply({ type: 'notice', message: `Dumped ${(t ? count(t) : 0).toLocaleString('en-US')} messages of ${message.topic} to /Users/dev/${message.topic}.jsonl, oldest first.` }, 500);
        break;
      }
      case 'prefs':
        sessionStorage.setItem(prefsKey, JSON.stringify({ ...readPrefs(), ...message.prefs }));
        break;
      case 'editDataSource':
        console.info('[dev host] the extension opens the data source editor');
        break;
      case 'copy':
        console.info('[dev host] copy\n' + message.text);
        void navigator.clipboard?.writeText(message.text).catch(() => undefined);
        reply({ type: 'notice', message: `Copied ${message.what} to the clipboard.` }, 50);
        break;
    }
  };
}
