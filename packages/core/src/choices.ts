import type { EngineId } from './engines';
import type {
  AuthMethod,
  ConnectionType,
  Environment,
  KafkaSaslMechanism,
  KafkaSecurityProtocol,
  MysqlDriver,
  PasswordStorage,
  SshAuthMethod,
  SslMode,
} from './dataSource';

/** Values and English labels for the form's select boxes. */
export interface Choice<T> {
  value: T;
  label: string;
}

export const ENVIRONMENTS: readonly Choice<Environment>[] = [
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

export const MYSQL_DRIVERS: readonly Choice<MysqlDriver>[] = [
  { value: 'mysql', label: 'MySQL' },
  { value: 'mariadb', label: 'MariaDB' },
];

export const CONNECTION_TYPES: readonly Choice<ConnectionType>[] = [
  { value: 'tcp', label: 'Default' },
  { value: 'socket', label: 'Unix socket' },
];

export const AUTH_METHODS: readonly Choice<AuthMethod>[] = [
  { value: 'password', label: 'User & Password' },
  { value: 'none', label: 'No auth' },
];

export const REDIS_AUTH_METHODS: readonly Choice<AuthMethod>[] = [
  { value: 'password', label: 'Password' },
  { value: 'acl', label: 'Username & Password (ACL)' },
  { value: 'none', label: 'No auth' },
];

/** Kafka has no auth select: the security protocol turns SASL on (`password`) or off. */
export const KAFKA_AUTH_METHODS: readonly Choice<AuthMethod>[] = [
  { value: 'password', label: 'SASL' },
  { value: 'none', label: 'No SASL' },
];

/** PostgreSQL always names a user; `none` connects without a password, e.g. under trust or peer authentication. */
export const POSTGRES_AUTH_METHODS: readonly Choice<AuthMethod>[] = [
  { value: 'password', label: 'User & Password' },
  { value: 'none', label: 'User only, no password' },
];

export function authMethodsFor(engine: EngineId): readonly Choice<AuthMethod>[] {
  if (engine === 'kafka') return KAFKA_AUTH_METHODS;
  if (engine === 'postgres') return POSTGRES_AUTH_METHODS;
  return engine === 'redis' ? REDIS_AUTH_METHODS : AUTH_METHODS;
}

export const MONGO_CONNECTION_FORMATS: readonly Choice<boolean>[] = [
  { value: false, label: 'Standard' },
  { value: true, label: 'DNS seed list (SRV)' },
];

export const KAFKA_SECURITY_PROTOCOLS: readonly Choice<KafkaSecurityProtocol>[] = [
  { value: 'PLAINTEXT', label: 'PLAINTEXT' },
  { value: 'SSL', label: 'SSL' },
  { value: 'SASL_PLAINTEXT', label: 'SASL_PLAINTEXT' },
  { value: 'SASL_SSL', label: 'SASL_SSL' },
];

export const KAFKA_SASL_MECHANISMS: readonly Choice<KafkaSaslMechanism>[] = [
  { value: 'PLAIN', label: 'PLAIN' },
  { value: 'SCRAM-SHA-256', label: 'SCRAM-SHA-256' },
  { value: 'SCRAM-SHA-512', label: 'SCRAM-SHA-512' },
  { value: 'OAUTHBEARER', label: 'OAUTHBEARER' },
];

export const PASSWORD_STORAGE: readonly Choice<PasswordStorage>[] = [
  { value: 'forever', label: 'Forever' },
  { value: 'session', label: 'Until restart' },
  { value: 'never', label: 'Never' },
];

export const SSH_AUTH_METHODS: readonly Choice<SshAuthMethod>[] = [
  { value: 'key', label: 'Key pair' },
  { value: 'password', label: 'Password' },
  { value: 'agent', label: 'OpenSSH agent' },
];

export const SSL_MODES: readonly Choice<SslMode>[] = [
  { value: 'require', label: 'Require' },
  { value: 'verify-ca', label: 'Verify CA' },
  { value: 'verify-full', label: 'Full verification' },
];

export const TRANSACTION_MODES: readonly Choice<boolean>[] = [
  { value: true, label: 'Auto-commit' },
  { value: false, label: 'Manual' },
];

export function choiceLabel<T>(choices: readonly Choice<T>[], value: T): string {
  return choices.find((c) => c.value === value)?.label ?? String(value);
}
