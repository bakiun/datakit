import type {
  KafkaAcl,
  KafkaAclOperation,
  KafkaAclPatternType,
  KafkaAclPermission,
  KafkaAclResourceType,
  KafkaBroker,
  KafkaConfigEntry,
  KafkaConfigSource,
  KafkaGroupDetail,
  KafkaGroupMember,
  KafkaGroupOffset,
  KafkaGroupSummary,
  KafkaLogDir,
  KafkaMessage,
  KafkaMessagePage,
  KafkaMessageQuery,
  KafkaOffsetTarget,
  KafkaOverview,
  KafkaPartitionIssue,
  KafkaPositions,
  KafkaProduceResult,
  KafkaRecord,
  KafkaSession,
  KafkaTopicDetail,
  KafkaTopicPartition,
  KafkaTopicSpec,
  KafkaTopicSummary,
  KafkaValueFormat,
  ServerVersion,
} from '@datakit/core';
import {
  AclOperations,
  AclPermissionTypes,
  Base,
  ConfigResourceTypes,
  ConfigSources,
  FindCoordinatorKeyTypes,
  IncrementalAlterConfigOperationTypes,
  murmur2,
  ProduceAcks,
  Producer,
  ResourcePatternTypes,
  ResourceTypes,
  type Acl,
  type AclFilter,
  type Admin,
  type alterPartitionReassignmentsV0,
  type BaseOptions,
  type BrokerLogDirDescription,
  type ConfigResourceTypeValue,
  type consumerGroupDescribeV0,
  type GroupBase,
  type MessageToProduce,
} from '@platformatic/kafka';
import { hasKafkaError, protocolError, readable, responseOf } from './errors';
import type { KafkaConnectRestClient } from './kafkaConnect';
import type { KsqlDbRestClient } from './ksqlDb';
import { MessageReader } from './messages';
import { EARLIEST, LATEST, listOffsets, maxBig, minBig, topicOffsets, type OffsetTable } from './offsets';
import { encodeInt64 } from './payload';
import { anyConnection, brokerConnection, describeConfigs, getApi, readCluster, type ClusterState, type ConfigResult, type TopicState } from './raw';
import { SchemaCodec, type SchemaRegistryRestClient } from './schemaRegistry';

export interface KafkaRestClients {
  schemaRegistry: SchemaRegistryRestClient | null;
  connect: KafkaConnectRestClient | null;
  ksqlDb: KsqlDbRestClient | null;
}

const CONFIG_SOURCES: Partial<Record<number, KafkaConfigSource>> = {
  [ConfigSources.DYNAMIC_TOPIC_CONFIG]: 'topic',
  [ConfigSources.DYNAMIC_BROKER_CONFIG]: 'broker',
  [ConfigSources.DYNAMIC_DEFAULT_BROKER_CONFIG]: 'cluster',
  [ConfigSources.STATIC_BROKER_CONFIG]: 'static',
  [ConfigSources.DEFAULT_CONFIG]: 'default',
};

const ACL_RESOURCE_TYPES: Record<KafkaAclResourceType, number> = {
  TOPIC: ResourceTypes.TOPIC,
  GROUP: ResourceTypes.GROUP,
  CLUSTER: ResourceTypes.CLUSTER,
  TRANSACTIONAL_ID: ResourceTypes.TRANSACTIONAL_ID,
  DELEGATION_TOKEN: ResourceTypes.DELEGATION_TOKEN,
  USER: ResourceTypes.USER,
};
const ACL_PATTERNS: Record<KafkaAclPatternType, number> = { LITERAL: ResourcePatternTypes.LITERAL, PREFIXED: ResourcePatternTypes.PREFIXED };
const ACL_OPERATIONS: Record<KafkaAclOperation, number> = {
  ALL: AclOperations.ALL,
  READ: AclOperations.READ,
  WRITE: AclOperations.WRITE,
  CREATE: AclOperations.CREATE,
  DELETE: AclOperations.DELETE,
  ALTER: AclOperations.ALTER,
  DESCRIBE: AclOperations.DESCRIBE,
  CLUSTER_ACTION: AclOperations.CLUSTER_ACTION,
  DESCRIBE_CONFIGS: AclOperations.DESCRIBE_CONFIGS,
  ALTER_CONFIGS: AclOperations.ALTER_CONFIGS,
  IDEMPOTENT_WRITE: AclOperations.IDEMPOTENT_WRITE,
  CREATE_TOKENS: AclOperations.CREATE_TOKENS,
  DESCRIBE_TOKENS: AclOperations.DESCRIBE_TOKENS,
};
const ACL_PERMISSIONS: Record<KafkaAclPermission, number> = { ALLOW: AclPermissionTypes.ALLOW, DENY: AclPermissionTypes.DENY };

/** The name of a wire value in one of the tables above. */
function nameOf<K extends string>(table: Record<K, number>, value: number): K | null {
  return (Object.keys(table) as K[]).find((key) => table[key] === value) ?? null;
}

/** Records per produce request, and the bytes they may hold: brokers refuse batches over `message.max.bytes`, 1 MiB by default. */
const PRODUCE_BATCH = 1000;
const PRODUCE_BATCH_BYTES = 512 * 1024;
const REASSIGNMENT_TIMEOUT_MS = 30_000;
const UNKNOWN_TOPIC_OR_PARTITION = 3;

type ConsumerGroupDescribeResponse = consumerGroupDescribeV0.ConsumerGroupDescribeResponse;
type ReassignmentTopic = alterPartitionReassignmentsV0.AlterPartitionReassignmentsRequestTopic;

interface GroupInfo {
  state: string;
  members: KafkaGroupMember[];
}

const partitionKey = (topic: string, partition: number) => `${topic}\u0000${partition}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lagOf = (end: bigint | undefined, committed: bigint) => (end === undefined ? null : Number(maxBig(0n, end - committed)));

export class KafkaClientSession implements KafkaSession {
  readonly kind = 'kafka';
  readonly schemaRegistry: SchemaRegistryRestClient | null;
  readonly connect: KafkaConnectRestClient | null;
  readonly ksqlDb: KsqlDbRestClient | null;
  private readonly codec: SchemaCodec | null;
  private readonly messages: MessageReader;
  private producer: Producer | null = null;
  private reader: Base | null = null;
  private tailer: Base | null = null;
  private readonly roundRobin = new Map<string, number>();
  private closed = false;
  private readonly listeners: ((error?: Error) => void)[] = [];

  constructor(
    private readonly admin: Admin,
    private readonly options: BaseOptions,
    readonly serverVersion: ServerVersion,
    rest: KafkaRestClients,
    /** Names the cluster in connection errors. */
    private readonly target: string,
  ) {
    this.schemaRegistry = rest.schemaRegistry;
    this.connect = rest.connect;
    this.ksqlDb = rest.ksqlDb;
    this.codec = rest.schemaRegistry ? new SchemaCodec(rest.schemaRegistry) : null;
    this.messages = new MessageReader({
      admin,
      reader: () => (this.reader ??= this.client(() => new Base(options))),
      tailer: () => (this.tailer ??= this.client(() => new Base(options))),
      codec: this.codec,
    });
  }

  private client<T>(create: () => T): T {
    if (this.closed) throw new Error('The connection to the cluster is closed.');
    return create();
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    return readable(this.target, work);
  }

  private cluster(topics: string[] | null): Promise<ClusterState> {
    return readCluster(this.admin, topics);
  }

  private async topicState(name: string): Promise<{ cluster: ClusterState; topic: TopicState }> {
    const cluster = await this.cluster([name]);
    const topic = cluster.topics.get(name);
    if (!topic) throw new Error(`Topic ${name} does not exist.`);
    return { cluster, topic };
  }

  // Cluster

  overview(): Promise<KafkaOverview> {
    return this.run(async () => {
      const cluster = await this.cluster(null);
      const [brokers, groups] = await Promise.all([this.brokersOf(cluster), this.groupSummaries()]);
      const topics = [...cluster.topics.values()];
      const visible = topics.filter((t) => !t.internal);
      const underReplicated: KafkaPartitionIssue[] = [];
      const offline: KafkaPartitionIssue[] = [];
      for (const t of topics) {
        for (const p of t.partitions) {
          const issue = { topic: t.name, partition: p.partition, leader: p.leader, replicas: p.replicas, isr: p.isr };
          if (p.leader < 0 || !cluster.brokers.has(p.leader)) offline.push(issue);
          else if (p.isr.length < p.replicas.length) underReplicated.push(issue);
        }
      }
      return {
        clusterId: cluster.clusterId,
        controllerId: cluster.controllerId,
        brokers,
        topics: visible.length,
        partitions: visible.reduce((n, t) => n + t.partitions.length, 0),
        replicationFactors: [...new Set(visible.map((t) => t.partitions[0]?.replicas.length ?? 0))].sort((a, b) => a - b),
        underReplicated,
        offline,
        groups,
        checkedAt: Date.now(),
      };
    });
  }

  brokers(): Promise<KafkaBroker[]> {
    return this.run(async () => this.brokersOf(await this.cluster(null)));
  }

  private async brokersOf(cluster: ClusterState): Promise<KafkaBroker[]> {
    const dirs = await this.logDirs(cluster);
    const counts = new Map<number, { leaders: number; replicas: number; inSync: number; outOfSync: number }>();
    const countOf = (id: number) => {
      let c = counts.get(id);
      if (!c) counts.set(id, (c = { leaders: 0, replicas: 0, inSync: 0, outOfSync: 0 }));
      return c;
    };
    for (const id of cluster.brokers.keys()) countOf(id);
    for (const topic of cluster.topics.values()) {
      for (const p of topic.partitions) {
        if (p.leader >= 0) countOf(p.leader).leaders++;
        for (const r of p.replicas) {
          const c = countOf(r);
          c.replicas++;
          if (p.isr.includes(r)) c.inSync++;
          else c.outOfSync++;
        }
      }
    }
    const brokers: KafkaBroker[] = [];
    for (const [id, c] of counts) {
      const node = cluster.brokers.get(id);
      const description = dirs?.find((d) => d.broker === id);
      const logDirs: KafkaLogDir[] = (description?.results ?? []).map((dir) => {
        const sized = (n: bigint) => (n >= 0n ? Number(n) : null);
        let bytes = 0n;
        for (const t of dir.topics) for (const p of t.partitions) if (!p.isFutureKey) bytes += p.partitionSize;
        return { path: dir.logDir, bytes: Number(bytes), totalBytes: sized(dir.totalBytes), usableBytes: sized(dir.usableBytes) };
      });
      brokers.push({
        id,
        host: node?.host ?? '',
        port: node?.port ?? 0,
        rack: node?.rack ?? null,
        controller: id === cluster.controllerId,
        // Replicas name it but the metadata does not: the broker is gone.
        online: !!node,
        ...c,
        logDirs,
      });
    }
    return brokers.sort((a, b) => a.id - b.id);
  }

  /** Log dirs of every broker with the sizes of the partitions in them; null when a broker cannot say. */
  private async logDirs(cluster: ClusterState, only?: TopicState): Promise<BrokerLogDirDescription[] | null> {
    const topics = (only ? [only] : [...cluster.topics.values()]).map((t) => ({ name: t.name, partitions: t.partitions.map((p) => p.partition) }));
    try {
      return await this.admin.describeLogDirs({ topics });
    } catch {
      return null;
    }
  }

  /** Bytes of the largest replica of each partition, by topic and partition. */
  private sizesOf(dirs: BrokerLogDirDescription[] | null): Map<string, bigint> | null {
    if (!dirs) return null;
    const sizes = new Map<string, bigint>();
    for (const broker of dirs) {
      for (const dir of broker.results) {
        for (const t of dir.topics) {
          for (const p of t.partitions) {
            if (p.isFutureKey) continue;
            const key = partitionKey(t.name, p.partitionIndex);
            sizes.set(key, maxBig(sizes.get(key) ?? 0n, p.partitionSize));
          }
        }
      }
    }
    return sizes;
  }

  brokerConfigs(brokerId: number): Promise<KafkaConfigEntry[]> {
    return this.run(async () => {
      const broker = (await this.cluster([])).brokers.get(brokerId);
      if (!broker) throw new Error(`Broker ${brokerId} is not in the cluster.`);
      const [result] = await describeConfigs(this.admin, [{ resourceType: ConfigResourceTypes.BROKER, resourceName: String(brokerId) }], true, broker);
      return configEntries(result);
    });
  }

  setBrokerConfig(brokerId: number, name: string, value: string | null): Promise<void> {
    return this.run(() => this.alterConfig(ConfigResourceTypes.BROKER, String(brokerId), name, value));
  }

  private async alterConfig(resourceType: ConfigResourceTypeValue, resourceName: string, name: string, value: string | null): Promise<void> {
    const config =
      value === null
        ? { name, configOperation: IncrementalAlterConfigOperationTypes.DELETE }
        : { name, configOperation: IncrementalAlterConfigOperationTypes.SET, value };
    await this.admin.incrementalAlterConfigs({ resources: [{ resourceType, resourceName, configs: [config] }] });
  }

  // Topics

  topics(): Promise<KafkaTopicSummary[]> {
    return this.run(async () => {
      const cluster = await this.cluster(null);
      const topics = [...cluster.topics.values()];
      const details = await this.describeTopics(cluster, topics);
      return details.map(({ partitionInfo: _, ...summary }) => summary).sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  topic(name: string): Promise<KafkaTopicDetail | null> {
    return this.run(async () => {
      const cluster = await this.cluster([name]);
      const topic = cluster.topics.get(name);
      if (!topic) return null;
      return (await this.describeTopics(cluster, [topic], topic))[0]!;
    });
  }

  /** Offsets, sizes and retention of topics, each read for all of them at once. */
  private async describeTopics(cluster: ClusterState, topics: TopicState[], only?: TopicState): Promise<KafkaTopicDetail[]> {
    const wanted = topics.map((topic) => ({ topic, partitions: topic.partitions.map((p) => p.partition) }));
    const [starts, ends, configs, dirs] = await Promise.all([
      listOffsets(this.admin, wanted, EARLIEST),
      listOffsets(this.admin, wanted, LATEST),
      describeConfigs(
        this.admin,
        topics.map((t) => ({ resourceType: ConfigResourceTypes.TOPIC, resourceName: t.name, configurationKeys: ['retention.ms', 'cleanup.policy'] })),
        false,
      ),
      this.logDirs(cluster, only),
    ]);
    const sizes = this.sizesOf(dirs);
    const configsByTopic = new Map(configs.filter((r) => r.errorCode === 0).map((r) => [r.resourceName, r.configs]));
    const configOf = (topic: string, name: string) => configsByTopic.get(topic)?.find((c) => c.name === name)?.value ?? null;
    return topics.map((t) => {
      const partitionInfo = t.partitions.map((p) => ({
        partition: p.partition,
        leader: p.leader,
        replicas: p.replicas,
        isr: p.isr,
        start: (starts.get(t.name)?.get(p.partition) ?? 0n).toString(),
        end: (ends.get(t.name)?.get(p.partition) ?? 0n).toString(),
      }));
      let bytes: bigint | null = sizes ? 0n : null;
      if (sizes) for (const p of t.partitions) bytes = bytes! + (sizes.get(partitionKey(t.name, p.partition)) ?? 0n);
      const retention = configOf(t.name, 'retention.ms');
      return {
        name: t.name,
        internal: t.internal,
        partitions: t.partitions.length,
        replicationFactor: t.partitions[0]?.replicas.length ?? 0,
        messages: partitionInfo.reduce((n, p) => n + Number(BigInt(p.end) - BigInt(p.start)), 0),
        bytes: bytes === null ? null : Number(bytes),
        retentionMs: retention === null || !/^-?\d+$/.test(retention) ? null : Number(retention),
        cleanupPolicy: configOf(t.name, 'cleanup.policy') ?? 'delete',
        underReplicated: t.partitions.filter((p) => p.isr.length < p.replicas.length).length,
        partitionInfo,
      };
    });
  }

  topicConfigs(name: string): Promise<KafkaConfigEntry[]> {
    return this.run(async () => {
      const [result] = await describeConfigs(this.admin, [{ resourceType: ConfigResourceTypes.TOPIC, resourceName: name }], true);
      if (result?.errorCode === UNKNOWN_TOPIC_OR_PARTITION) throw new Error(`Topic ${name} does not exist.`);
      return configEntries(result);
    });
  }

  setTopicConfig(topic: string, name: string, value: string | null): Promise<void> {
    return this.run(async () => {
      await this.topicState(topic);
      await this.alterConfig(ConfigResourceTypes.TOPIC, topic, name, value);
    });
  }

  createTopic(spec: KafkaTopicSpec): Promise<void> {
    return this.run(async () => {
      await this.admin.createTopics({
        topics: [spec.name.trim()],
        partitions: spec.partitions,
        replicas: spec.replicationFactor,
        configs: Object.entries(spec.configs).map(([name, value]) => ({ name, value })),
      });
    });
  }

  deleteTopic(name: string): Promise<void> {
    return this.run(async () => {
      // Checked first: the broker's answer for a missing topic is retried before it fails.
      await this.topicState(name);
      await this.admin.deleteTopics({ topics: [name] });
    });
  }

  clearTopic(name: string): Promise<number> {
    return this.run(async () => {
      const { topic } = await this.topicState(name);
      const [config] = await describeConfigs(this.admin, [{ resourceType: ConfigResourceTypes.TOPIC, resourceName: name, configurationKeys: ['cleanup.policy'] }], false);
      const policy = config?.configs.find((c) => c.name === 'cleanup.policy')?.value ?? 'delete';
      if (!policy.split(',').map((p) => p.trim()).includes('delete')) {
        throw new Error(`${name} is compacted (cleanup.policy=${policy}); Kafka deletes records only from topics whose policy includes delete.`);
      }
      const all = topic.partitions.map((p) => p.partition);
      const [starts, ends] = await Promise.all([topicOffsets(this.admin, topic, all, EARLIEST), topicOffsets(this.admin, topic, all, LATEST)]);
      const partitions = all.filter((p) => (ends.get(p) ?? 0n) > (starts.get(p) ?? 0n)).map((partition) => ({ partition, offset: ends.get(partition)! }));
      if (!partitions.length) return 0;
      const deleted = await this.admin.deleteRecords({ topics: [{ name, partitions }] });
      let count = 0n;
      for (const t of deleted) for (const p of t.partitions) count += maxBig(0n, p.lowWatermark - (starts.get(p.partition) ?? p.lowWatermark));
      return Number(count);
    });
  }

  addPartitions(name: string, total: number): Promise<void> {
    return this.run(async () => {
      await this.topicState(name);
      await this.admin.createPartitions({ topics: [{ name, count: total }] });
    });
  }

  changeReplicationFactor(name: string, replicationFactor: number): Promise<void> {
    return this.run(async () => {
      const cluster = await this.cluster(null);
      const topic = cluster.topics.get(name);
      if (!topic) throw new Error(`Topic ${name} does not exist.`);
      const online = [...cluster.brokers.keys()].sort((a, b) => a - b);
      if (!Number.isInteger(replicationFactor) || replicationFactor < 1) throw new Error('The replication factor must be a whole number of at least 1.');
      if (replicationFactor > online.length) {
        throw new Error(`A replication factor of ${replicationFactor} needs ${replicationFactor} brokers; the cluster has ${online.length}.`);
      }
      const load = new Map(online.map((id) => [id, 0]));
      for (const t of cluster.topics.values()) for (const p of t.partitions) for (const r of p.replicas) if (load.has(r)) load.set(r, load.get(r)! + 1);

      const partitions: ReassignmentTopic['partitions'] = [];
      for (const p of topic.partitions) {
        const replicas = [...p.replicas];
        while (replicas.length < replicationFactor) {
          // The broker with the fewest replicas that does not have one of this partition yet.
          const pick = online.filter((id) => !replicas.includes(id)).sort((a, b) => load.get(a)! - load.get(b)! || a - b)[0]!;
          replicas.push(pick);
          load.set(pick, load.get(pick)! + 1);
        }
        while (replicas.length > replicationFactor) {
          // Replicas on brokers that are gone go first, then the last ones; the leader stays.
          const gone = replicas.findIndex((r) => !load.has(r));
          const index = gone >= 0 ? gone : replicas.findLastIndex((r) => r !== p.leader);
          const [removed] = replicas.splice(index, 1);
          if (load.has(removed!)) load.set(removed!, load.get(removed!)! - 1);
        }
        if (replicas.join() !== p.replicas.join()) partitions.push({ partitionIndex: p.partition, replicas });
      }
      if (!partitions.length) return;

      const api = await getApi<[number, boolean, ReassignmentTopic[]], unknown>(this.admin, 'AlterPartitionReassignments');
      // KRaft brokers pass the request on to the controller; a ZooKeeper cluster needs its controller.
      const controller = cluster.brokers.get(cluster.controllerId);
      const connection = controller ? await brokerConnection(this.admin, controller) : await anyConnection(this.admin);
      await api.async(connection, REASSIGNMENT_TIMEOUT_MS, true, [{ name, partitions }]);
    });
  }

  // Messages

  readMessages(query: KafkaMessageQuery): Promise<KafkaMessagePage> {
    return this.run(() => this.messages.readMessages(query));
  }

  tail(topic: string, positions: KafkaPositions, waitMs: number): Promise<{ messages: KafkaMessage[]; positions: KafkaPositions }> {
    return this.run(() => this.messages.tail(topic, positions, waitMs));
  }

  async readAll(topic: string, onChunk: (messages: KafkaMessage[], read: number, total: number) => Promise<boolean> | boolean): Promise<number> {
    // An error of the caller, e.g. a file it cannot write, is passed on as it is rather than read as a broker error.
    const caller = { failed: false, error: undefined as unknown };
    const guarded = async (messages: KafkaMessage[], read: number, total: number) => {
      try {
        return await onChunk(messages, read, total);
      } catch (error) {
        Object.assign(caller, { failed: true, error });
        throw error;
      }
    };
    try {
      return await this.run(() => this.messages.readAll(topic, guarded));
    } catch (error) {
      throw caller.failed ? caller.error : error;
    }
  }

  sampleFormat(topic: string): Promise<string | null> {
    return this.run(() => this.messages.sampleFormat(topic));
  }

  produce(topic: string, records: KafkaRecord[], valueFormat: KafkaValueFormat): Promise<KafkaProduceResult[]> {
    return this.run(async () => {
      if (!records.length) return [];
      const { topic: state } = await this.topicState(topic);
      const count = state.partitions.length;
      const encode = await this.valueEncoder(topic, valueFormat);
      const messages = records.map((r): MessageToProduce => {
        const key = r.key === null ? undefined : Buffer.from(r.key, 'utf8');
        if (r.partition !== null && (!Number.isInteger(r.partition) || r.partition < 0 || r.partition >= count)) {
          throw new Error(`Partition ${r.partition} does not exist; ${topic} has ${plural(count, 'partition')}.`);
        }
        return {
          topic,
          partition: r.partition ?? this.partitionFor(topic, key, count),
          key,
          value: r.value === null ? undefined : encode(r.value),
          headers: new Map(r.headers.map((h) => [Buffer.from(h.key, 'utf8'), Buffer.from(h.value, 'utf8')])),
        };
      });
      const producer = (this.producer ??= this.client(() => new Producer({ ...this.options, acks: ProduceAcks.ALL })));
      const results: KafkaProduceResult[] = [];
      for (const batch of batches(messages)) {
        const sent = await producer.send({ messages: batch, acks: ProduceAcks.ALL });
        // Records of a partition are written in order from its base offset.
        const base = new Map((sent.offsets ?? []).map((o) => [o.partition, o.offset]));
        const seen = new Map<number, bigint>();
        for (const m of batch) {
          const index = seen.get(m.partition!) ?? 0n;
          seen.set(m.partition!, index + 1n);
          results.push({ partition: m.partition!, offset: ((base.get(m.partition!) ?? 0n) + index).toString() });
        }
      }
      return results;
    });
  }

  /** The Java client's choice for a key: murmur2 of the key, made positive, modulo the partitions; without a key, round robin. */
  private partitionFor(topic: string, key: Buffer | undefined, count: number): number {
    if (key) return (murmur2(key) & 0x7fffffff) % count;
    const next = this.roundRobin.get(topic) ?? Math.floor(Math.random() * count);
    this.roundRobin.set(topic, (next + 1) % count);
    return next % count;
  }

  private async valueEncoder(topic: string, format: KafkaValueFormat): Promise<(value: string) => Buffer> {
    switch (format) {
      case 'int64':
        return encodeInt64;
      case 'avro':
        if (!this.codec) throw new Error('Avro needs a Schema Registry URL on the data source.');
        return this.codec.avroEncoder(`${topic}-value`);
      default:
        return (value) => Buffer.from(value, 'utf8');
    }
  }

  // Consumer groups

  groups(): Promise<KafkaGroupSummary[]> {
    return this.run(() => this.groupSummaries());
  }

  private async groupSummaries(): Promise<KafkaGroupSummary[]> {
    const listed = [...(await this.listGroups()).values()];
    if (!listed.length) return [];
    const [info, committed] = await Promise.all([this.describeGroups(listed), this.committedOffsets(listed.map((g) => g.id))]);
    const ends = await this.partitionOffsets([...committed.values()]);
    return listed
      .map((g) => this.summary(g, info.get(g.id), committed.get(g.id) ?? new Map(), ends))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private summary(g: GroupBase, info: GroupInfo | undefined, committed: OffsetTable, ends: OffsetTable | null): KafkaGroupSummary {
    const lagByTopic: Record<string, number | null> = {};
    for (const [topic, partitions] of committed) {
      let lag: number | null = 0;
      for (const [partition, offset] of partitions) {
        const behind = lagOf(ends?.get(topic)?.get(partition), offset);
        lag = lag === null || behind === null ? null : lag + behind;
      }
      lagByTopic[topic] = lag;
    }
    const state = info?.state && info.state !== 'Unknown' ? info.state : g.state;
    return { id: g.id, state, protocolType: g.protocolType, members: info?.members.length ?? 0, lagByTopic };
  }

  /** Groups of every type. Without a types filter Kafka 4 lists classic groups only; an empty one means all. */
  private listGroups(): Promise<Map<string, GroupBase>> {
    return this.admin.listGroups({ types: [] });
  }

  /** Committed offsets by group, topic and partition; partitions without one are left out. */
  private async committedOffsets(ids: string[]): Promise<Map<string, OffsetTable>> {
    const result = new Map<string, OffsetTable>();
    if (!ids.length) return result;
    let groups: Awaited<ReturnType<Admin['listConsumerGroupOffsets']>>;
    try {
      groups = await this.admin.listConsumerGroupOffsets({ groups: ids });
    } catch (error) {
      if (ids.length === 1) throw error;
      // One group that cannot answer fails the request; ask the others one by one.
      const each = await Promise.all(ids.map((id) => this.admin.listConsumerGroupOffsets({ groups: [id] }).catch(() => [])));
      groups = each.flat();
    }
    for (const group of groups) {
      const table: OffsetTable = new Map();
      for (const topic of group.topics) {
        const partitions = new Map<number, bigint>();
        for (const p of topic.partitions) if (p.committedOffset >= 0n) partitions.set(p.partitionIndex, p.committedOffset);
        if (partitions.size) table.set(topic.name, partitions);
      }
      result.set(group.groupId, table);
    }
    return result;
  }

  /** End (or other) offsets of every partition the tables name, in one call; null when they could not be read. */
  private async partitionOffsets(tables: OffsetTable[], timestamp: bigint = LATEST): Promise<OffsetTable | null> {
    const wantedByTopic = new Map<string, Set<number>>();
    for (const table of tables) for (const [topic, partitions] of table) for (const p of partitions.keys()) wantedByTopic.set(topic, (wantedByTopic.get(topic) ?? new Set()).add(p));
    if (!wantedByTopic.size) return new Map();
    try {
      const cluster = await this.cluster([...wantedByTopic.keys()]);
      const wanted = [...wantedByTopic].flatMap(([name, partitions]) => {
        const topic = cluster.topics.get(name);
        return topic ? [{ topic, partitions: [...partitions].filter((p) => p < topic.partitions.length) }] : [];
      });
      return await listOffsets(this.admin, wanted, timestamp);
    } catch {
      return null;
    }
  }

  /** State and members of groups: classic groups with DescribeGroups, groups of the consumer protocol (KIP-848) with ConsumerGroupDescribe. */
  private async describeGroups(groups: GroupBase[]): Promise<Map<string, GroupInfo>> {
    const info = new Map<string, GroupInfo>();
    const modern = groups.filter((g) => g.groupType === 'consumer').map((g) => g.id);
    const classic = groups.filter((g) => !g.groupType || g.groupType === 'classic').map((g) => g.id);
    const describeClassic = async (ids: string[]) => {
      for (const [id, g] of await this.admin.describeGroups({ groups: ids })) {
        const members = [...g.members.values()].map((m) => ({
          id: m.id,
          clientId: m.clientId,
          host: m.clientHost.replace(/^\//, ''),
          assignments: [...(m.assignments?.values() ?? [])].flatMap((a) => a.partitions.map((partition) => ({ topic: a.topic, partition }))),
        }));
        info.set(id, { state: g.state, members });
      }
    };
    await Promise.all([
      classic.length
        ? describeClassic(classic).catch(async () => {
            // One group that cannot be described fails the request; describe them one by one.
            await Promise.all(classic.map((id) => describeClassic([id]).catch(() => undefined)));
          })
        : undefined,
      modern.length ? this.describeConsumerGroups(modern, info).catch(() => undefined) : undefined,
    ]);
    return info;
  }

  private async describeConsumerGroups(ids: string[], into: Map<string, GroupInfo>): Promise<void> {
    const coordinators = await this.admin.findCoordinator({ keyType: FindCoordinatorKeyTypes.GROUP, keys: ids });
    const byNode = new Map<number, { broker: { host: string; port: number }; ids: string[] }>();
    for (const c of coordinators) {
      const entry = byNode.get(c.nodeId) ?? { broker: { host: c.host, port: c.port }, ids: [] };
      entry.ids.push(c.key);
      byNode.set(c.nodeId, entry);
    }
    const api = await getApi<[string[], boolean], ConsumerGroupDescribeResponse>(this.admin, 'ConsumerGroupDescribe');
    await Promise.all(
      [...byNode.values()].map(async ({ broker, ids: groupIds }) => {
        const connection = await brokerConnection(this.admin, broker);
        let response: ConsumerGroupDescribeResponse;
        try {
          response = await api.async(connection, groupIds, false);
        } catch (error) {
          const partial = responseOf<ConsumerGroupDescribeResponse>(error);
          if (!partial?.groups) throw error;
          response = partial;
        }
        for (const g of response.groups) {
          if (g.errorCode !== 0) continue;
          const members = g.members.map((m) => ({
            id: m.memberId,
            clientId: m.clientId,
            host: m.clientHost.replace(/^\//, ''),
            assignments: m.assignment.topicPartitions.flatMap((t) => t.partitions.map((partition) => ({ topic: t.topicName, partition }))),
          }));
          into.set(g.groupId, { state: g.groupState, members });
        }
      }),
    );
  }

  private async findGroup(id: string): Promise<{ listed: GroupBase; info: GroupInfo | undefined } | null> {
    const listed = (await this.listGroups()).get(id);
    if (!listed) return null;
    return { listed, info: (await this.describeGroups([listed])).get(id) };
  }

  group(id: string): Promise<KafkaGroupDetail | null> {
    return this.run(async () => {
      const found = await this.findGroup(id);
      if (!found) return null;
      const committed = (await this.committedOffsets([id])).get(id) ?? new Map();
      // Assigned partitions without a committed offset are listed too.
      const table: OffsetTable = new Map([...committed].map(([t, p]) => [t, new Map(p)]));
      for (const m of found.info?.members ?? []) for (const a of m.assignments) if (!table.get(a.topic)?.has(a.partition)) table.set(a.topic, (table.get(a.topic) ?? new Map()).set(a.partition, -1n));
      const [starts, ends] = await Promise.all([this.partitionOffsets([table], EARLIEST), this.partitionOffsets([table], LATEST)]);
      const offsets: KafkaGroupOffset[] = [];
      for (const [topic, partitions] of table) {
        for (const [partition, offset] of partitions) {
          const end = ends?.get(topic)?.get(partition);
          offsets.push({
            topic,
            partition,
            committed: offset >= 0n ? offset.toString() : null,
            start: (starts?.get(topic)?.get(partition) ?? 0n).toString(),
            end: (end ?? 0n).toString(),
            lag: offset >= 0n ? lagOf(end, offset) : null,
          });
        }
      }
      offsets.sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
      return { ...this.summary(found.listed, found.info, committed, ends), offsets, memberDetails: found.info?.members ?? [] };
    });
  }

  resetOffsets(id: string, partitions: KafkaTopicPartition[] | null, target: KafkaOffsetTarget): Promise<void> {
    return this.run(async () => {
      const found = await this.findGroup(id);
      const members = found?.info?.members.length ?? 0;
      if (members > 0) throw new Error(`${id} has ${plural(members, 'active member')}. Offsets can only be changed after its consumers stop.`);
      let chosen = partitions;
      if (!chosen) {
        const committed = (await this.committedOffsets([id])).get(id) ?? new Map<string, Map<number, bigint>>();
        chosen = [...committed].flatMap(([topic, ps]) => [...ps.keys()].map((partition) => ({ topic, partition })));
      }
      if (!chosen.length) return;
      const byTopic = new Map<string, number[]>();
      for (const p of chosen) byTopic.set(p.topic, [...(byTopic.get(p.topic) ?? []), p.partition]);
      const cluster = await this.cluster([...byTopic.keys()]);
      const wanted = [...byTopic].map(([name, ps]) => {
        const topic = cluster.topics.get(name);
        if (!topic) throw new Error(`Topic ${name} does not exist.`);
        const missing = ps.find((p) => p < 0 || p >= topic.partitions.length);
        if (missing !== undefined) throw new Error(`Partition ${missing} does not exist; ${name} has ${plural(topic.partitions.length, 'partition')}.`);
        return { topic, partitions: ps };
      });
      const [starts, ends, atTime] = await Promise.all([
        listOffsets(this.admin, wanted, EARLIEST),
        listOffsets(this.admin, wanted, LATEST),
        target.kind === 'timestamp' ? listOffsets(this.admin, wanted, BigInt(Math.floor(target.time))) : null,
      ]);
      if (target.kind === 'offset' && !/^\d+$/.test(target.offset.trim())) throw new Error('The offset must be a whole number.');
      const topics = wanted.map(({ topic, partitions: ps }) => ({
        name: topic.name,
        partitionOffsets: ps.map((partition) => {
          const start = starts.get(topic.name)?.get(partition) ?? 0n;
          const end = ends.get(topic.name)?.get(partition) ?? 0n;
          let offset: bigint;
          switch (target.kind) {
            case 'earliest':
              offset = start;
              break;
            case 'latest':
              offset = end;
              break;
            case 'timestamp': {
              // No message at or after the time: the group starts after the last one.
              const found = atTime?.get(topic.name)?.get(partition) ?? -1n;
              offset = found < 0n ? end : found;
              break;
            }
            case 'offset':
              offset = minBig(end, maxBig(start, BigInt(target.offset.trim())));
              break;
          }
          return { partition, offset };
        }),
      }));
      await this.admin.alterConsumerGroupOffsets({ groupId: id, topics });
    });
  }

  deleteGroup(id: string): Promise<void> {
    return this.run(() => this.admin.deleteGroups({ groups: [id] }));
  }

  // ACLs

  acls(): Promise<KafkaAcl[] | null> {
    return this.run(async () => {
      const filter: AclFilter = {
        resourceType: ResourceTypes.ANY,
        resourceName: null,
        resourcePatternType: ResourcePatternTypes.ANY,
        principal: null,
        host: null,
        operation: AclOperations.ANY,
        permissionType: AclPermissionTypes.ANY,
      };
      let resources;
      try {
        resources = await this.admin.describeAcls({ filter });
      } catch (error) {
        // No authorizer: the cluster does not use ACLs.
        if (hasKafkaError(error, 'SECURITY_DISABLED')) return null;
        throw error;
      }
      const acls: KafkaAcl[] = [];
      for (const r of resources) {
        const resourceType = nameOf(ACL_RESOURCE_TYPES, r.resourceType);
        const patternType = nameOf(ACL_PATTERNS, r.resourcePatternType);
        if (!resourceType || !patternType) continue;
        for (const a of r.acls) {
          const operation = nameOf(ACL_OPERATIONS, a.operation);
          const permission = nameOf(ACL_PERMISSIONS, a.permissionType);
          if (!operation || !permission) continue;
          acls.push({ principal: a.principal, host: a.host, resourceType, resourceName: r.resourceName, patternType, operation, permission });
        }
      }
      return acls;
    });
  }

  createAcls(acls: KafkaAcl[]): Promise<void> {
    return this.run(async () => {
      if (acls.length) await this.admin.createAcls({ creations: acls.map(toAcl) });
    });
  }

  deleteAcls(acls: KafkaAcl[]): Promise<number> {
    return this.run(async () => (acls.length ? (await this.admin.deleteAcls({ filters: acls.map(toAcl) })).length : 0));
  }

  // Session

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const clients: { close(): Promise<void> }[] = [this.admin, this.producer, this.reader, this.tailer].filter((c) => c !== null);
    await Promise.allSettled(clients.map((c) => c.close()));
    for (const listener of this.listeners) listener();
  }

  onDidClose(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }
}

function toAcl(acl: KafkaAcl): Acl {
  return {
    resourceType: ACL_RESOURCE_TYPES[acl.resourceType] as Acl['resourceType'],
    resourceName: acl.resourceName,
    resourcePatternType: ACL_PATTERNS[acl.patternType] as Acl['resourcePatternType'],
    principal: acl.principal,
    host: acl.host,
    operation: ACL_OPERATIONS[acl.operation] as Acl['operation'],
    permissionType: ACL_PERMISSIONS[acl.permission] as Acl['permissionType'],
  };
}

function configEntries(result: ConfigResult | undefined): KafkaConfigEntry[] {
  if (!result) return [];
  if (result.errorCode !== 0) throw protocolError(result.errorCode, result.errorMessage);
  return result.configs
    .map((c) => ({
      name: c.name,
      value: c.isSensitive ? null : (c.value ?? null),
      source: CONFIG_SOURCES[c.configSource] ?? 'other',
      readOnly: c.readOnly,
      sensitive: c.isSensitive,
      documentation: c.documentation?.trim() || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Produce requests of at most PRODUCE_BATCH records and about PRODUCE_BATCH_BYTES. */
function* batches(messages: MessageToProduce[]): Generator<MessageToProduce[]> {
  let batch: MessageToProduce[] = [];
  let bytes = 0;
  for (const m of messages) {
    const size = (m.key?.length ?? 0) + (m.value?.length ?? 0);
    if (batch.length && (batch.length >= PRODUCE_BATCH || bytes + size > PRODUCE_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(m);
    bytes += size;
  }
  if (batch.length) yield batch;
}
