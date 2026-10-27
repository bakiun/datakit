import type { Environment, KafkaSecurityProtocol } from '../dataSource';
import type { KafkaProduceTemplate } from '../kafka/produce';
import type {
  Connector,
  ConnectorAction,
  KafkaAcl,
  KafkaBroker,
  KafkaConfigEntry,
  KafkaGroupDetail,
  KafkaGroupSummary,
  KafkaMessage,
  KafkaMessagePage,
  KafkaMessageQuery,
  KafkaOffsetTarget,
  KafkaOverview,
  KafkaPositions,
  KafkaProduceResult,
  KafkaTopicDetail,
  KafkaTopicPartition,
  KafkaTopicSpec,
  KafkaTopicSummary,
  KsqlColumn,
  KsqlDbInfo,
  KsqlResult,
  SchemaCompatibility,
  SchemaSubject,
  SchemaType,
  SchemaVersionDetail,
} from '../kafka/types';

/** Messages between the extension and the Kafka workspace webview: one tab per Kafka data source. */

export type KafkaSection = 'overview' | 'brokers' | 'topics' | 'consumers' | 'acls' | 'schemas' | 'connect' | 'ksql';

export const KAFKA_SECTIONS: readonly { id: KafkaSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'brokers', label: 'Brokers' },
  { id: 'topics', label: 'Topics' },
  { id: 'consumers', label: 'Consumers' },
  { id: 'acls', label: 'ACLs' },
  { id: 'schemas', label: 'Schema Registry' },
  { id: 'connect', label: 'Kafka Connect' },
  { id: 'ksql', label: 'ksqlDB' },
];

/** Choices the workspace remembers per data source; a missing one uses the default. */
export interface KafkaWorkspacePrefs {
  /** Messages per page in the message browser; the data source's page size until one is picked. */
  pageSize?: number;
  /** The last ksqlDB statement run, and where its queries start reading. */
  ksqlStatement?: string;
  ksqlOffsetReset?: 'earliest' | 'latest';
}

export interface KafkaWorkspaceInit {
  dataSourceName: string;
  environment: Environment;
  /** e.g. `Kafka 4.0`; just `Kafka` when the version is unknown. */
  serverLabel: string;
  securityProtocol: KafkaSecurityProtocol;
  bootstrapServers: string;
  readOnly: boolean;
  /** Messages per page, from the Options tab. */
  pageSize: number;
  /** The REST services; null when the data source names none, and their sections then say how to add one. */
  schemaRegistryUrl: string | null;
  connectUrl: string | null;
  ksqlDbUrl: string | null;
  favourites: string[];
  prefs: KafkaWorkspacePrefs;
  /** Where the workspace opens, e.g. the section picked in the tree. */
  section: KafkaSection;
  topic: string | null;
}

/** What the page asks to (re)load; `loadFailed` names the same. */
export type KafkaLoad = 'overview' | 'brokers' | 'topics' | 'groups' | 'acls' | 'subjects' | 'connectors' | 'ksqlInfo';

/** Changes the page asks for. The page confirms deletions itself; production data sources ask again in VS Code. */
export type KafkaWrite =
  | { kind: 'setBrokerConfig'; brokerId: number; name: string; value: string | null }
  /** `cloneOf` copies the topic overrides of that topic first; `spec.configs` wins over them. */
  | { kind: 'createTopic'; spec: KafkaTopicSpec; cloneOf: string | null }
  | { kind: 'deleteTopic'; topic: string }
  | { kind: 'clearTopic'; topic: string }
  /** Deletes the topic and creates it again with the same partitions, replication factor and overrides. */
  | { kind: 'recreateTopic'; topic: string }
  /** Partitions can only grow; a new replication factor starts a reassignment. */
  | { kind: 'repartition'; topic: string; partitions: number; replicationFactor: number }
  | { kind: 'setTopicConfig'; topic: string; name: string; value: string | null }
  | { kind: 'produce'; topic: string; template: KafkaProduceTemplate }
  | { kind: 'resetOffsets'; groupId: string; partitions: KafkaTopicPartition[] | null; target: KafkaOffsetTarget }
  | { kind: 'deleteGroup'; groupId: string }
  | { kind: 'createAcls'; acls: KafkaAcl[] }
  | { kind: 'deleteAcls'; acls: KafkaAcl[] }
  | { kind: 'setGlobalCompatibility'; level: SchemaCompatibility }
  | { kind: 'setCompatibility'; subject: string; level: SchemaCompatibility | null }
  /** Checks compatibility with the latest version first and refuses an incompatible schema. */
  | { kind: 'registerSchema'; subject: string; schemaType: SchemaType; schema: string }
  | { kind: 'deleteSchemaVersion'; subject: string; version: number; permanent: boolean }
  /** `resetOffsets` stops a connector that is not stopped first, since Connect only resets stopped ones. */
  | { kind: 'connector'; name: string; action: ConnectorAction }
  | { kind: 'restartTask'; name: string; task: number }
  /** Restarts every failed connector and task. */
  | { kind: 'restartFailed' }
  /** Creates a connector, or replaces the config of an existing one. */
  | { kind: 'saveConnector'; name: string; config: Record<string, string> };

export type KafkaWriteKind = KafkaWrite['kind'];

export type KafkaWorkspaceHostMessage =
  /** Sent on start, and again when the data source is edited; the page then keeps its place. */
  | { type: 'init'; init: KafkaWorkspaceInit }
  | { type: 'initFailed'; message: string }
  /** The tree asked for a section, e.g. when the workspace was already open. */
  | { type: 'navigate'; section: KafkaSection; topic: string | null }
  /** `connectors` and `subjects` are null when the service is not configured or could not be read. */
  | { type: 'overview'; overview: KafkaOverview; connectors: Connector[] | null; subjects: number | null; globalCompatibility: SchemaCompatibility | null }
  | { type: 'brokers'; brokers: KafkaBroker[] }
  | { type: 'brokerConfigs'; brokerId: number; configs: KafkaConfigEntry[] }
  | { type: 'topics'; topics: KafkaTopicSummary[] }
  /** Sent after `topics`: what each topic's newest message looks like, e.g. `JSON` or `Avro · v4`. */
  | { type: 'topicFormats'; formats: Record<string, string> }
  | { type: 'topic'; detail: KafkaTopicDetail }
  | { type: 'topicGone'; topic: string }
  | { type: 'topicConfigs'; topic: string; configs: KafkaConfigEntry[] }
  /** The answer to `messages`; `requestId` lets the page drop answers to older requests. */
  | { type: 'messages'; requestId: number; topic: string; page: KafkaMessagePage; durationMs: number }
  | { type: 'messagesFailed'; requestId: number; message: string }
  /** New messages of a live stream that match its filter, newest first. */
  | { type: 'streamed'; topic: string; messages: KafkaMessage[] }
  /** The stream ended; `message` says why when it was not stopped by the page. */
  | { type: 'streamStopped'; topic: string; message: string | null }
  /** `results` are where the first messages landed; `count` is how many were produced in all. */
  | { type: 'produced'; topic: string; count: number; results: KafkaProduceResult[] }
  | { type: 'groups'; groups: KafkaGroupSummary[] }
  | { type: 'group'; detail: KafkaGroupDetail }
  | { type: 'groupGone'; groupId: string }
  /** `acls` is null when the cluster has no authorizer. */
  | { type: 'acls'; acls: KafkaAcl[] | null }
  | { type: 'subjects'; subjects: SchemaSubject[]; globalCompatibility: SchemaCompatibility }
  | { type: 'schema'; detail: SchemaVersionDetail }
  | { type: 'connectors'; connectors: Connector[]; workers: number; version: string }
  | { type: 'connectorConfig'; name: string; config: Record<string, string> }
  | { type: 'ksqlInfo'; info: KsqlDbInfo }
  | { type: 'ksqlColumns'; runId: number; columns: KsqlColumn[] }
  | { type: 'ksqlRows'; runId: number; rows: unknown[][] }
  | { type: 'ksqlDone'; runId: number; result: KsqlResult; durationMs: number }
  /** `cancelled` when the user declined the Production confirmation; the page then shows nothing. */
  | { type: 'ksqlFailed'; runId: number; message: string; cancelled?: true }
  | { type: 'loadFailed'; what: KafkaLoad | 'topic' | 'topicConfigs' | 'brokerConfigs' | 'group' | 'schema' | 'connectorConfig'; message: string }
  /** A write worked; `message` is shown as a toast. The page reloads what it shows. */
  | { type: 'done'; kind: KafkaWriteKind; message: string }
  /**
   * A write did not happen: refused, or failed on the server. `cancelled` when the user declined VS Code's
   * Production confirmation, which needs no message.
   */
  | { type: 'failed'; kind: KafkaWriteKind; message: string; cancelled?: true }
  | { type: 'favourites'; names: string[] }
  | { type: 'notice'; message: string; error?: boolean };

export type KafkaWorkspaceWebviewMessage =
  | { type: 'ready' }
  | { type: 'load'; what: KafkaLoad }
  | { type: 'brokerConfigs'; brokerId: number }
  /** Answered with `topic` and `topicConfigs`, or `topicGone`. */
  | { type: 'openTopic'; topic: string }
  | { type: 'messages'; requestId: number; query: KafkaMessageQuery }
  /** Streams new messages from `positions` (a page's positions) on; only those matching the filter are sent. */
  | { type: 'stream'; topic: string; positions: KafkaPositions; partition: number | null; text: string | null }
  | { type: 'stopStream' }
  | { type: 'openGroup'; groupId: string }
  | { type: 'schema'; subject: string; version: number | 'latest' }
  | { type: 'connectorConfig'; name: string }
  /** Runs a ksqlDB statement; queries stream rows until they end or `ksqlStop`. */
  | { type: 'ksql'; runId: number; statement: string; properties: Record<string, string> }
  | { type: 'ksqlStop'; runId: number }
  | { type: 'write'; write: KafkaWrite }
  | { type: 'favourite'; topic: string; on: boolean }
  /** Saves every message of the topic to a JSON Lines file the user picks, oldest first. */
  | { type: 'dump'; topic: string }
  /** Copies text the page put together; `what` is named in the confirmation, e.g. `40 messages`. */
  | { type: 'copy'; text: string; what: string }
  /** Merges into the remembered choices of the data source. */
  | { type: 'prefs'; prefs: KafkaWorkspacePrefs }
  /** Opens the data source's settings, e.g. to add a Schema Registry URL. */
  | { type: 'editDataSource' };
