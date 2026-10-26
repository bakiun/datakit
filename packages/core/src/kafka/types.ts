import type { ServerSession } from '../sql/session';

/** A partition of a topic. */
export interface KafkaTopicPartition {
  topic: string;
  partition: number;
}

/** Next offset to read per partition, keyed by the partition number; offsets are decimal strings (they are int64). */
export type KafkaPositions = Record<string, string>;

export interface KafkaLogDir {
  path: string;
  /** Bytes the partitions in this directory take; null when the broker does not report sizes. */
  bytes: number | null;
  /** Size and free space of the disk; null on brokers older than Kafka 3.3. */
  totalBytes: number | null;
  usableBytes: number | null;
}

export interface KafkaBroker {
  id: number;
  host: string;
  port: number;
  rack: string | null;
  controller: boolean;
  /** False for a broker that replicas name but the cluster metadata no longer lists. */
  online: boolean;
  /** Partitions this broker leads. */
  leaders: number;
  /** Replicas on this broker, and how many of them are in or out of the in-sync set. */
  replicas: number;
  inSync: number;
  outOfSync: number;
  logDirs: KafkaLogDir[];
}

/** A partition whose in-sync replicas are fewer than its replicas, or that has no leader. */
export interface KafkaPartitionIssue extends KafkaTopicPartition {
  leader: number;
  replicas: number[];
  isr: number[];
}

/** Where a config value comes from. `topic` and `broker` are overrides set on that resource; `cluster` is the cluster-wide dynamic default. */
export type KafkaConfigSource = 'topic' | 'broker' | 'cluster' | 'static' | 'default' | 'other';

export interface KafkaConfigEntry {
  name: string;
  /** Null for sensitive values and settings without a value. */
  value: string | null;
  source: KafkaConfigSource;
  readOnly: boolean;
  sensitive: boolean;
  /** The server's own description, when it sends one. */
  documentation: string | null;
}

export interface KafkaTopicSummary {
  name: string;
  internal: boolean;
  partitions: number;
  /** Replicas of the first partition; topics rarely mix them. */
  replicationFactor: number;
  /** End minus start offset summed over the partitions; on compacted topics more than the messages kept. */
  messages: number;
  /** Bytes on disk of one replica of each partition; null when the brokers do not report log dirs. */
  bytes: number | null;
  /** `retention.ms`; -1 keeps messages forever, null when it could not be read. */
  retentionMs: number | null;
  /** `cleanup.policy`, e.g. `delete`, `compact` or `compact,delete`. */
  cleanupPolicy: string;
  underReplicated: number;
}

export interface KafkaPartitionInfo {
  partition: number;
  /** -1 when the partition has no leader. */
  leader: number;
  replicas: number[];
  isr: number[];
  /** First and next offset: the partition holds offsets start … end-1. */
  start: string;
  end: string;
}

export interface KafkaTopicDetail extends KafkaTopicSummary {
  partitionInfo: KafkaPartitionInfo[];
}

export interface KafkaTopicSpec {
  name: string;
  partitions: number;
  replicationFactor: number;
  /** Topic configs to set, e.g. `retention.ms`. */
  configs: Record<string, string>;
}

/** Bytes of a key, value or header, made readable. */
export interface KafkaPayload {
  /** The bytes as UTF-8 text, or as lower-case hex pairs when they are not valid UTF-8 (`binary`). */
  text: string;
  binary: boolean;
  /** Size of the whole payload in bytes. */
  size: number;
  /** True when `text` holds only the start of a large payload. */
  truncated: boolean;
  /** Set when the payload uses the Schema Registry wire format: a 0 byte, then the schema id. */
  schemaId: number | null;
  /** The value decoded with its schema, as JSON text; null without a Schema Registry or when decoding failed. */
  decoded: string | null;
}

export interface KafkaHeader {
  key: string;
  /** UTF-8 text, or `\x..` escapes for bytes that are not; null for a null header value. */
  value: string | null;
}

export interface KafkaMessage {
  partition: number;
  offset: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  key: KafkaPayload | null;
  value: KafkaPayload | null;
  headers: KafkaHeader[];
}

/** Which messages to read. Every filter is optional; the page holds the newest matches first. */
export interface KafkaMessageQuery {
  topic: string;
  /** Messages to return at most. */
  limit: number;
  partition: number | null;
  /** Inclusive offset range, applied to each partition read. */
  fromOffset: string | null;
  toOffset: string | null;
  /** Inclusive range of message timestamps in milliseconds. */
  fromTime: number | null;
  toTime: number | null;
  /** Keeps messages whose key, value or a header contains this text, ignoring case. */
  text: string | null;
}

export interface KafkaMessagePage {
  /** Newest first. */
  messages: KafkaMessage[];
  /** Messages read to fill the page; more than are shown when a text filter skipped some. */
  scanned: number;
  /** True when a text search stopped at its budget before it reached the start of the range. */
  partial: boolean;
  /** The end offset of each partition when it was read, where a live stream continues. */
  positions: KafkaPositions;
}

/** How a produced value is encoded. Keys and headers are always UTF-8 text. */
export type KafkaValueFormat = 'json' | 'string' | 'avro' | 'int64';

/** One message to produce; a null partition lets the partitioner choose. */
export interface KafkaRecord {
  partition: number | null;
  key: string | null;
  value: string | null;
  headers: { key: string; value: string }[];
}

export interface KafkaProduceResult {
  partition: number;
  offset: string;
}

export interface KafkaGroupSummary {
  id: string;
  /** As Kafka names it, e.g. `Stable`, `Empty`, `PreparingRebalance`, `Dead`. */
  state: string;
  /** `consumer` for consumer groups; Connect workers and other clients use other protocol types. */
  protocolType: string;
  members: number;
  /** Lag summed per topic the group has offsets for; null when an end offset could not be read. */
  lagByTopic: Record<string, number | null>;
}

export interface KafkaGroupOffset extends KafkaTopicPartition {
  /** Null when the group has no committed offset for the partition. */
  committed: string | null;
  start: string;
  end: string;
  /** End minus committed; null without a committed offset. */
  lag: number | null;
}

export interface KafkaGroupMember {
  id: string;
  clientId: string;
  host: string;
  assignments: KafkaTopicPartition[];
}

export interface KafkaGroupDetail extends KafkaGroupSummary {
  offsets: KafkaGroupOffset[];
  memberDetails: KafkaGroupMember[];
}

/** Where to move a group's committed offsets. An offset is clamped to the partition's start and end. */
export type KafkaOffsetTarget =
  | { kind: 'earliest' }
  | { kind: 'latest' }
  | { kind: 'timestamp'; time: number }
  | { kind: 'offset'; offset: string };

export type KafkaAclResourceType = 'TOPIC' | 'GROUP' | 'CLUSTER' | 'TRANSACTIONAL_ID' | 'DELEGATION_TOKEN' | 'USER';
export type KafkaAclPatternType = 'LITERAL' | 'PREFIXED';
export type KafkaAclOperation =
  | 'ALL'
  | 'READ'
  | 'WRITE'
  | 'CREATE'
  | 'DELETE'
  | 'ALTER'
  | 'DESCRIBE'
  | 'CLUSTER_ACTION'
  | 'DESCRIBE_CONFIGS'
  | 'ALTER_CONFIGS'
  | 'IDEMPOTENT_WRITE'
  | 'CREATE_TOKENS'
  | 'DESCRIBE_TOKENS';
export type KafkaAclPermission = 'ALLOW' | 'DENY';

export interface KafkaAcl {
  principal: string;
  /** `*` for any host. */
  host: string;
  resourceType: KafkaAclResourceType;
  resourceName: string;
  patternType: KafkaAclPatternType;
  operation: KafkaAclOperation;
  permission: KafkaAclPermission;
}

export interface KafkaOverview {
  clusterId: string;
  /** -1 when the metadata names no controller. */
  controllerId: number;
  brokers: KafkaBroker[];
  /** Topics and partitions, internal topics left out. */
  topics: number;
  partitions: number;
  /** The replication factors in use, smallest first. */
  replicationFactors: number[];
  underReplicated: KafkaPartitionIssue[];
  offline: KafkaPartitionIssue[];
  groups: KafkaGroupSummary[];
  /** When the overview was read, in milliseconds since the epoch. */
  checkedAt: number;
}

/** An open connection to a Kafka cluster, implemented by the Kafka adapter. Writes throw with the broker's message. */
export interface KafkaSession extends ServerSession {
  readonly kind: 'kafka';
  /** The REST services named on the data source; null when it names none. */
  readonly schemaRegistry: SchemaRegistryClient | null;
  readonly connect: KafkaConnectClient | null;
  readonly ksqlDb: KsqlDbClient | null;

  overview(): Promise<KafkaOverview>;
  brokers(): Promise<KafkaBroker[]>;
  /** Every config of a broker; the ones that are not read-only can be changed while it runs. */
  brokerConfigs(brokerId: number): Promise<KafkaConfigEntry[]>;
  /** Sets a per-broker override; null removes it. */
  setBrokerConfig(brokerId: number, name: string, value: string | null): Promise<void>;

  /** Every topic, internal ones included and flagged. */
  topics(): Promise<KafkaTopicSummary[]>;
  /** Null when the topic does not exist. */
  topic(name: string): Promise<KafkaTopicDetail | null>;
  topicConfigs(name: string): Promise<KafkaConfigEntry[]>;
  /** Sets a topic override; null removes it, so the broker default applies. */
  setTopicConfig(topic: string, name: string, value: string | null): Promise<void>;
  createTopic(spec: KafkaTopicSpec): Promise<void>;
  deleteTopic(name: string): Promise<void>;
  /** Deletes the messages of every partition up to its end offset; returns how many offsets were deleted. */
  clearTopic(name: string): Promise<number>;
  /** Grows the topic to `total` partitions. */
  addPartitions(name: string, total: number): Promise<void>;
  /** Starts a reassignment that gives every partition `replicationFactor` replicas. */
  changeReplicationFactor(name: string, replicationFactor: number): Promise<void>;

  readMessages(query: KafkaMessageQuery): Promise<KafkaMessagePage>;
  /** Messages after `positions`, oldest first, waiting up to `waitMs` when there are none yet. */
  tail(topic: string, positions: KafkaPositions, waitMs: number): Promise<{ messages: KafkaMessage[]; positions: KafkaPositions }>;
  /**
   * Reads every partition from its start, oldest first, a chunk at a time; `onChunk` returns false to stop.
   * Payloads are not cut short. Returns the number of messages read.
   */
  readAll(topic: string, onChunk: (messages: KafkaMessage[], read: number, total: number) => Promise<boolean> | boolean): Promise<number>;
  /** What the newest message looks like, e.g. `JSON`, `Avro`, `String` or `Binary`; null when the topic is empty. */
  sampleFormat(topic: string): Promise<string | null>;
  produce(topic: string, records: KafkaRecord[], valueFormat: KafkaValueFormat): Promise<KafkaProduceResult[]>;

  groups(): Promise<KafkaGroupSummary[]>;
  /** Null when the group does not exist. */
  group(id: string): Promise<KafkaGroupDetail | null>;
  /** Moves the committed offsets of `partitions`, or of every partition the group has offsets for when null. */
  resetOffsets(id: string, partitions: KafkaTopicPartition[] | null, target: KafkaOffsetTarget): Promise<void>;
  deleteGroup(id: string): Promise<void>;

  /** Null when the cluster has no authorizer, so ACLs are not used. */
  acls(): Promise<KafkaAcl[] | null>;
  createAcls(acls: KafkaAcl[]): Promise<void>;
  /** Returns how many ACLs were deleted. */
  deleteAcls(acls: KafkaAcl[]): Promise<number>;
}

export type SchemaType = 'AVRO' | 'JSON' | 'PROTOBUF';
export type SchemaCompatibility =
  | 'BACKWARD'
  | 'BACKWARD_TRANSITIVE'
  | 'FORWARD'
  | 'FORWARD_TRANSITIVE'
  | 'FULL'
  | 'FULL_TRANSITIVE'
  | 'NONE';

export interface SchemaSubject {
  name: string;
  type: SchemaType;
  latestVersion: number;
  latestId: number;
}

export interface SchemaVersionDetail {
  subject: string;
  version: number;
  id: number;
  type: SchemaType;
  /** The schema as registered: JSON text for Avro and JSON Schema, .proto text for Protobuf. */
  schema: string;
  /** Every version that is not deleted, oldest first. */
  versions: number[];
  /** The subject's own level; null when it uses the global one. */
  compatibility: SchemaCompatibility | null;
}

/** The Confluent Schema Registry REST API. */
export interface SchemaRegistryClient {
  readonly url: string;
  subjects(): Promise<SchemaSubject[]>;
  version(subject: string, version: number | 'latest'): Promise<SchemaVersionDetail>;
  globalCompatibility(): Promise<SchemaCompatibility>;
  setGlobalCompatibility(level: SchemaCompatibility): Promise<void>;
  /** Null removes the subject's own level. */
  setCompatibility(subject: string, level: SchemaCompatibility | null): Promise<void>;
  /** Checks a schema against the latest version; a subject without versions is always compatible. */
  checkCompatibility(subject: string, type: SchemaType, schema: string): Promise<{ compatible: boolean; messages: string[] }>;
  /** Registers a new version and returns its schema id. */
  register(subject: string, type: SchemaType, schema: string): Promise<number>;
  /** A soft delete hides the version; a permanent one removes a soft-deleted version for good. */
  deleteVersion(subject: string, version: number, permanent: boolean): Promise<void>;
}

export type ConnectorState = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'FAILED' | 'UNASSIGNED' | 'RESTARTING';

export interface ConnectorTask {
  id: number;
  state: ConnectorState;
  workerId: string;
  /** The stack trace of a failed task. */
  trace: string | null;
}

export interface Connector {
  name: string;
  type: 'source' | 'sink' | 'unknown';
  className: string;
  state: ConnectorState;
  workerId: string;
  trace: string | null;
  tasks: ConnectorTask[];
}

export type ConnectorAction = 'pause' | 'resume' | 'stop' | 'restart' | 'delete' | 'resetOffsets';

/** The Kafka Connect REST API. */
export interface KafkaConnectClient {
  readonly url: string;
  /** The version of the worker that answers, and how many workers run tasks. */
  info(): Promise<{ version: string; workers: number }>;
  connectors(): Promise<Connector[]>;
  config(name: string): Promise<Record<string, string>>;
  /** Creates the connector, or replaces the config of an existing one. */
  putConfig(name: string, config: Record<string, string>): Promise<void>;
  /** `restart` restarts the connector and all its tasks; `resetOffsets` needs a stopped connector. */
  act(name: string, action: ConnectorAction): Promise<void>;
  restartTask(name: string, task: number): Promise<void>;
}

export interface KsqlDbInfo {
  version: string;
  streams: number;
  tables: number;
  queries: number;
}

export interface KsqlColumn {
  name: string;
  type: string;
}

/** What core needs of an AbortSignal; core has neither DOM nor Node types. */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/** A query streams rows; any other statement answers with JSON, shown as text. */
export type KsqlResult = { kind: 'query'; rows: number } | { kind: 'statement'; text: string };

/** The ksqlDB REST API. */
export interface KsqlDbClient {
  readonly url: string;
  info(): Promise<KsqlDbInfo>;
  /**
   * Runs one statement with stream properties such as `auto.offset.reset`. A query (SELECT, PRINT is not one)
   * calls `onColumns` once and `onRows` as rows arrive, until it ends or `signal` aborts it.
   */
  run(
    statement: string,
    properties: Record<string, string>,
    handlers: { onColumns(columns: KsqlColumn[]): void; onRows(rows: unknown[][]): void },
    signal: CancelSignal,
  ): Promise<KsqlResult>;
}
