import type { DriverProperty } from './dataSource';

/** Server engines the extension can connect to. */
export type EngineId = 'mysql' | 'postgres' | 'redis' | 'kafka' | 'mongodb';

export type DriverOptionType = 'boolean' | 'number' | 'string';

export interface EngineDescriptor {
  id: EngineId;
  name: string;
  /** Client library the driver properties are passed to. */
  driverLibrary: string;
  defaultPort: string;
  defaultUser: string;
  /** Options of the client library that can be set as driver properties or URL parameters, with their value type. */
  driverOptions: Readonly<Record<string, DriverOptionType>>;
  /** Rows the Advanced tab starts with for a new data source. */
  defaultProperties: readonly DriverProperty[];
  /** Driver properties that are set from the form and may not be overridden, mapped to the tab that owns them. */
  reservedProperties: Readonly<Record<string, string>>;
}

/**
 * mysql2 connection options with plain values. Left out: options the form sets, callbacks and objects
 * (typeCast, authPlugins, …), pool-only options, and `rowsAsArray`/`nestTables`, which change the result shape.
 */
const MYSQL2_OPTIONS: Record<string, DriverOptionType> = {
  bigNumberStrings: 'boolean',
  charset: 'string',
  charsetNumber: 'number',
  compress: 'boolean',
  connectTimeout: 'number',
  dateStrings: 'boolean',
  debug: 'boolean',
  decimalNumbers: 'boolean',
  disableEval: 'boolean',
  enableCleartextPlugin: 'boolean',
  enableKeepAlive: 'boolean',
  flags: 'string',
  insecureAuth: 'boolean',
  jsonStrings: 'boolean',
  keepAliveInitialDelay: 'number',
  localAddress: 'string',
  maxPreparedStatements: 'number',
  multipleStatements: 'boolean',
  namedPlaceholders: 'boolean',
  stringifyObjects: 'boolean',
  supportBigNumbers: 'boolean',
  timezone: 'string',
  trace: 'boolean',
};

/**
 * node-postgres (pg) client options with plain values, by their `pg.Client` names; `application_name` and `options`
 * (e.g. `-c search_path=shop`) are also libpq URL parameters. Left out: what the form sets (host, port, user,
 * password, database, TLS), `statement_timeout`, which the query timeout on the Options tab sets, `types` and callbacks.
 */
const PG_OPTIONS: Record<string, DriverOptionType> = {
  application_name: 'string',
  client_encoding: 'string',
  connectionTimeoutMillis: 'number',
  enableChannelBinding: 'boolean',
  fallback_application_name: 'string',
  idle_in_transaction_session_timeout: 'number',
  keepAlive: 'boolean',
  keepAliveInitialDelayMillis: 'number',
  lock_timeout: 'number',
  options: 'string',
  query_timeout: 'number',
};

/**
 * node-redis client options with plain values, by the name they have in the Advanced tab; the adapter puts the
 * socket ones under `socket`. `scanCount` is not a client option: it is the COUNT hint the key browser sends with SCAN.
 * Left out: `keyPrefix`, which would make the keys SCAN returns differ from the keys the browser can read.
 */
const NODE_REDIS_OPTIONS: Record<string, DriverOptionType> = {
  connectTimeout: 'number',
  socketTimeout: 'number',
  keepAlive: 'boolean',
  keepAliveInitialDelay: 'number',
  noDelay: 'boolean',
  name: 'string',
  pingInterval: 'number',
  commandsQueueMaxLength: 'number',
  disableOfflineQueue: 'boolean',
  disableClientInfo: 'boolean',
  scanCount: 'number',
};

/**
 * @platformatic/kafka client options with plain values. Left out: what the form sets (brokers, client id, SASL, TLS),
 * callbacks, and options of producers and consumers, which the workspace sets per action.
 */
const PLATFORMATIC_KAFKA_OPTIONS: Record<string, DriverOptionType> = {
  connectTimeout: 'number',
  requestTimeout: 'number',
  timeout: 'number',
  retries: 'number',
  retryDelay: 'number',
  metadataMaxAge: 'number',
  maxInflights: 'number',
  clientRack: 'string',
};

/**
 * MongoDB driver options with plain values, by their URL option names. Left out: what the form sets (hosts, user,
 * auth source, replica set, TLS), auto encryption and callbacks.
 */
const MONGODB_OPTIONS: Record<string, DriverOptionType> = {
  appName: 'string',
  authMechanism: 'string',
  compressors: 'string',
  connectTimeoutMS: 'number',
  directConnection: 'boolean',
  heartbeatFrequencyMS: 'number',
  journal: 'boolean',
  loadBalanced: 'boolean',
  localThresholdMS: 'number',
  maxIdleTimeMS: 'number',
  maxPoolSize: 'number',
  minPoolSize: 'number',
  readConcernLevel: 'string',
  readPreference: 'string',
  retryReads: 'boolean',
  retryWrites: 'boolean',
  serverSelectionTimeoutMS: 'number',
  socketTimeoutMS: 'number',
  w: 'string',
  wtimeoutMS: 'number',
};

/** In the order of the design's engine tabs. */
export const ENGINES: readonly EngineDescriptor[] = [
  {
    id: 'mysql',
    name: 'MySQL',
    driverLibrary: 'mysql2',
    defaultPort: '3306',
    defaultUser: 'root',
    driverOptions: MYSQL2_OPTIONS,
    defaultProperties: [
      { key: 'connectTimeout', value: '10000' },
      { key: 'charset', value: 'utf8mb4' },
    ],
    reservedProperties: {
      host: 'General',
      port: 'General',
      socketPath: 'General',
      user: 'General',
      password: 'General',
      database: 'General',
      ssl: 'SSH / SSL',
      stream: 'SSH / SSL',
    },
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    driverLibrary: 'pg',
    defaultPort: '5432',
    defaultUser: 'postgres',
    driverOptions: PG_OPTIONS,
    defaultProperties: [
      { key: 'connectionTimeoutMillis', value: '10000' },
      { key: 'application_name', value: 'Datakit' },
    ],
    reservedProperties: {
      host: 'General',
      port: 'General',
      user: 'General',
      password: 'General',
      database: 'General',
      ssl: 'SSH / SSL',
      sslmode: 'SSH / SSL',
      stream: 'SSH / SSL',
      statement_timeout: 'Options',
    },
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    driverLibrary: 'mongodb',
    defaultPort: '27017',
    defaultUser: '',
    driverOptions: MONGODB_OPTIONS,
    defaultProperties: [
      { key: 'connectTimeoutMS', value: '10000' },
      { key: 'serverSelectionTimeoutMS', value: '10000' },
    ],
    reservedProperties: {
      authSource: 'General',
      replicaSet: 'General',
      username: 'General',
      password: 'General',
      tls: 'SSH / SSL',
      ssl: 'SSH / SSL',
      tlsCAFile: 'SSH / SSL',
      tlsCertificateKeyFile: 'SSH / SSL',
      tlsAllowInvalidCertificates: 'SSH / SSL',
      tlsAllowInvalidHostnames: 'SSH / SSL',
      tlsInsecure: 'SSH / SSL',
    },
  },
  {
    id: 'redis',
    name: 'Redis',
    driverLibrary: 'node-redis',
    defaultPort: '6379',
    defaultUser: '',
    driverOptions: NODE_REDIS_OPTIONS,
    defaultProperties: [
      { key: 'connectTimeout', value: '10000' },
      { key: 'scanCount', value: '500' },
    ],
    reservedProperties: {
      host: 'General',
      port: 'General',
      username: 'General',
      password: 'General',
      database: 'General',
      tls: 'SSH / SSL',
    },
  },
  {
    id: 'kafka',
    name: 'Kafka',
    driverLibrary: '@platformatic/kafka',
    defaultPort: '9092',
    defaultUser: '',
    driverOptions: PLATFORMATIC_KAFKA_OPTIONS,
    defaultProperties: [
      { key: 'connectTimeout', value: '10000' },
      { key: 'requestTimeout', value: '30000' },
      { key: 'retries', value: '3' },
    ],
    reservedProperties: {
      bootstrapBrokers: 'General',
      clientId: 'General',
      sasl: 'SSL / SASL',
      tls: 'SSL / SASL',
      ssl: 'SSL / SASL',
    },
  },
];

export function getEngine(id: EngineId): EngineDescriptor {
  const engine = ENGINES.find((e) => e.id === id);
  if (!engine) throw new Error(`Unknown engine: ${id}`);
  return engine;
}
