import { getEngine, type EngineId } from './engines';

export type Environment = 'development' | 'staging' | 'production';
export type MysqlDriver = 'mysql' | 'mariadb';
export type ConnectionType = 'tcp' | 'socket';
/**
 * `password` is a user and password for MySQL, the password alone (AUTH) for Redis and SASL for Kafka;
 * `acl` is a Redis ACL user.
 */
export type AuthMethod = 'password' | 'acl' | 'none';
export type PasswordStorage = 'forever' | 'session' | 'never';
export type SshAuthMethod = 'key' | 'password' | 'agent';
export type SslMode = 'require' | 'verify-ca' | 'verify-full';

export interface SshSettings {
  enabled: boolean;
  host: string;
  port: string;
  user: string;
  auth: SshAuthMethod;
  privateKeyPath: string;
}

export interface SslSettings {
  enabled: boolean;
  mode: SslMode;
  caFile: string;
  certFile: string;
  keyFile: string;
}

export type KafkaSaslMechanism = 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512' | 'OAUTHBEARER';
/** Kafka's `security.protocol`; it is not stored but follows from SASL (`auth`) and TLS (`ssl.enabled`). */
export type KafkaSecurityProtocol = 'PLAINTEXT' | 'SSL' | 'SASL_PLAINTEXT' | 'SASL_SSL';

/** Settings only a Kafka data source has. SASL uses `user` and the password secret; OAUTHBEARER takes a token as the password. */
export interface KafkaSettings {
  /** `host:port` pairs separated by commas. */
  bootstrapServers: string;
  saslMechanism: KafkaSaslMechanism;
  clientId: string;
  /** Base URLs of the REST services next to the cluster; empty when not used. */
  schemaRegistryUrl: string;
  connectUrl: string;
  ksqlDbUrl: string;
}

/** Settings only a MongoDB data source has. The user, password and default database are the common fields. */
export interface MongoSettings {
  /** `mongodb+srv://`: `hosts` is one DNS name, and the hosts and ports come from its SRV records. */
  srv: boolean;
  /** `host[:port]` pairs separated by commas; port 27017 when left out. */
  hosts: string;
  /** The database that holds the user; empty uses the default database, or `admin`. */
  authSource: string;
  /** The replica set name; empty to let the driver find out. */
  replicaSet: string;
}

export interface SessionOptions {
  readOnly: boolean;
  autoConnect: boolean;
  autoCommit: boolean;
  pageSize: number;
  /** Seconds; empty means the default. SQL only. */
  queryTimeout: string;
  initSql: string;
}

export interface DriverProperty {
  key: string;
  value: string;
}

/** Everything the user edits on the data source form. Numeric fields stay text until validated. */
export interface DataSourceSettings {
  engine: EngineId;
  name: string;
  comment: string;
  environment: Environment;
  driver: MysqlDriver;
  connectionType: ConnectionType;
  host: string;
  port: string;
  socketPath: string;
  auth: AuthMethod;
  user: string;
  passwordStorage: PasswordStorage;
  /** The default database; for Redis the database index, e.g. `0`. */
  database: string;
  ssh: SshSettings;
  ssl: SslSettings;
  /** Used by Kafka data sources only; the others keep the defaults. */
  kafka: KafkaSettings;
  /** Used by MongoDB data sources only; the others keep the defaults. */
  mongo: MongoSettings;
  options: SessionOptions;
  properties: DriverProperty[];
}

export interface DataSource extends DataSourceSettings {
  id: string;
}

export type SecretKey = 'password' | 'sshPassword' | 'sshPassphrase';
export type Secrets = Partial<Record<SecretKey, string>>;
/** A key that is present replaces the stored secret (an empty string is a valid password); a missing key keeps it. */
export type SecretPatch = Secrets;

export const PAGE_SIZES = [25, 50, 100, 500] as const;
export const DEFAULT_KAFKA_CLIENT_ID = 'datakit';
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 60;

export function createDataSourceSettings(engineId: EngineId = 'mysql'): DataSourceSettings {
  const engine = getEngine(engineId);
  return {
    engine: engineId,
    name: '',
    comment: '',
    environment: 'development',
    driver: 'mysql',
    connectionType: 'tcp',
    host: 'localhost',
    port: engine.defaultPort,
    socketPath: '',
    // New Kafka and MongoDB data sources start without auth, like a local broker or mongod.
    auth: engineId === 'kafka' || engineId === 'mongodb' ? 'none' : 'password',
    user: engine.defaultUser,
    passwordStorage: 'forever',
    // Redis databases are numbered; a PostgreSQL connection is bound to one database, `postgres` unless told otherwise.
    database: engineId === 'redis' ? '0' : engineId === 'postgres' ? 'postgres' : '',
    ssh: { enabled: false, host: '', port: '22', user: '', auth: 'key', privateKeyPath: '' },
    ssl: { enabled: false, mode: 'require', caFile: '', certFile: '', keyFile: '' },
    kafka: {
      bootstrapServers: 'localhost:9092',
      saslMechanism: 'PLAIN',
      clientId: DEFAULT_KAFKA_CLIENT_ID,
      schemaRegistryUrl: '',
      connectUrl: '',
      ksqlDbUrl: '',
    },
    mongo: { srv: false, hosts: 'localhost:27017', authSource: '', replicaSet: '' },
    options: {
      readOnly: false,
      autoConnect: false,
      autoCommit: true,
      pageSize: 100,
      queryTimeout: '',
      initSql: '',
    },
    properties: engine.defaultProperties.map((p) => ({ ...p })),
  };
}

export function cloneSettings<T extends DataSourceSettings>(settings: T): T {
  return JSON.parse(JSON.stringify(settings)) as T;
}

export function toSettings(dataSource: DataSource): DataSourceSettings {
  const { id: _id, ...settings } = cloneSettings(dataSource);
  return settings;
}

/** The bootstrap servers of a Kafka data source, trimmed, without empty entries. */
export function bootstrapServerList(kafka: KafkaSettings): string[] {
  return kafka.bootstrapServers
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
}

/** The hosts of a MongoDB data source, trimmed, without empty entries. */
export function mongoHostList(mongo: MongoSettings): string[] {
  return mongo.hosts
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

/** `host:port`, the socket path, or the first Kafka or MongoDB host and how many follow, for lists and tooltips. */
export function describeEndpoint(settings: DataSourceSettings): string {
  if (settings.engine === 'kafka' || settings.engine === 'mongodb') {
    const [first = '', ...rest] = settings.engine === 'kafka' ? bootstrapServerList(settings.kafka) : mongoHostList(settings.mongo);
    return rest.length ? `${first} +${rest.length}` : first;
  }
  return settings.connectionType === 'socket' ? settings.socketPath : `${settings.host}:${settings.port}`;
}

export function kafkaSecurityProtocol(settings: DataSourceSettings): KafkaSecurityProtocol {
  return `${settings.auth === 'none' ? '' : 'SASL_'}${settings.ssl.enabled ? 'SSL' : 'PLAINTEXT'}` as KafkaSecurityProtocol;
}

/** Sets SASL and TLS from a Kafka security protocol. */
export function setKafkaSecurityProtocol(settings: DataSourceSettings, protocol: KafkaSecurityProtocol): void {
  settings.auth = protocol.startsWith('SASL_') ? 'password' : 'none';
  settings.ssl.enabled = protocol.endsWith('SSL');
}

/** Whether connecting needs a password, typed or saved. */
export function needsPassword(settings: DataSourceSettings): boolean {
  return settings.auth !== 'none';
}

/**
 * Whether the form asks for a user name: MySQL with a password, PostgreSQL always, Redis with an ACL user, Kafka with
 * SASL but no token.
 */
export function needsUser(settings: DataSourceSettings): boolean {
  if (settings.engine === 'postgres') return true;
  if (settings.engine === 'redis') return settings.auth === 'acl';
  if (settings.engine === 'kafka') return settings.auth === 'password' && settings.kafka.saslMechanism !== 'OAUTHBEARER';
  return settings.auth === 'password';
}

/** The host part of `host:port` or `[ipv6]:port`. */
function hostOf(address: string): string {
  const bracketed = /^\[([^\]]+)\]/.exec(address);
  return bracketed ? bracketed[1]! : (address.split(':')[0] ?? '');
}

/**
 * The name a data source gets when the user leaves Name empty: `database@host`, or the host alone, made unique
 * against `otherNames` with a number (`localhost 2`).
 */
export function suggestDataSourceName(settings: DataSourceSettings, otherNames: readonly string[]): string {
  const host =
    settings.engine === 'kafka'
      ? hostOf(bootstrapServerList(settings.kafka)[0] ?? '')
      : settings.engine === 'mongodb'
        ? hostOf(mongoHostList(settings.mongo)[0] ?? '')
        : settings.engine === 'mysql' && settings.connectionType === 'socket'
          ? 'localhost'
          : settings.host.trim();
  const database = settings.engine === 'redis' || settings.engine === 'kafka' ? '' : settings.database.trim();
  const base = host ? (database ? `${database}@${host}` : host) : getEngine(settings.engine).name;
  const taken = new Set(otherNames.map((n) => n.trim().toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  return name;
}

/** A new form for another engine that keeps what the user already typed above the tabs. */
export function switchEngine(settings: DataSourceSettings, engine: EngineId): DataSourceSettings {
  return { ...createDataSourceSettings(engine), name: settings.name, comment: settings.comment, environment: settings.environment };
}

export function queryTimeoutSeconds(options: SessionOptions): number {
  return options.queryTimeout.trim() === '' ? DEFAULT_QUERY_TIMEOUT_SECONDS : Number(options.queryTimeout);
}
