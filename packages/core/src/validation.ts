import { authMethodsFor } from './choices';
import { bootstrapServerList, mongoHostList, needsUser, type DataSourceSettings } from './dataSource';
import { getEngine, type DriverOptionType } from './engines';

const PUBLIC_CA_ENGINES = new Set<string>(['kafka', 'mongodb']);

/** Error messages keyed by field path, e.g. `host`, `ssh.port`, `properties.2.key`. */
export type FieldErrors = Record<string, string>;

/** Form tabs; `name`, `comment` and `environment` sit above them and belong to none. */
export type FormSection = 'general' | 'ssh' | 'options' | 'advanced';

export function sectionOf(field: string): FormSection | null {
  if (field === 'name' || field === 'comment' || field === 'environment') return null;
  if (field.startsWith('ssh.') || field.startsWith('ssl.')) return 'ssh';
  if (field.startsWith('options.')) return 'options';
  if (field.startsWith('properties.')) return 'advanced';
  return 'general';
}

export function isValidPort(value: string): boolean {
  if (!/^\d{1,5}$/.test(value.trim())) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

/** Checks the form. `otherNames` are the names of the other data sources, which must not be reused. */
export function validateDataSource(s: DataSourceSettings, otherNames: readonly string[]): FieldErrors {
  const errors: FieldErrors = {};
  const name = s.name.trim();
  if (!name) errors.name = 'Name is required.';
  else if (otherNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) {
    errors.name = `Another data source is already named “${name}”.`;
  }

  if (s.engine === 'kafka') {
    validateKafka(s, errors);
  } else if (s.engine === 'mongodb') {
    validateMongo(s, errors);
  } else if (s.connectionType === 'tcp' || s.engine === 'redis' || s.engine === 'postgres') {
    if (!s.host.trim()) errors.host = 'Host is required.';
    if (!isValidPort(s.port)) errors.port = 'Port must be a number between 1 and 65535.';
  } else if (!s.socketPath.trim()) {
    errors.socketPath = 'Socket path is required.';
  }
  if (!authMethodsFor(s.engine).some((c) => c.value === s.auth)) errors.auth = 'Pick an authentication method.';
  if (needsUser(s) && !s.user.trim()) errors.user = 'User is required.';
  if (s.engine === 'redis' && !/^\d{1,4}$/.test(s.database.trim())) errors.database = 'Database index must be a whole number, e.g. 0.';

  // Kafka brokers hand out their own addresses, so one SSH tunnel cannot reach them; the form has no SSH for Kafka.
  if (s.ssh.enabled && s.engine !== 'kafka') {
    if (!s.ssh.host.trim()) errors['ssh.host'] = 'SSH proxy host is required.';
    if (!isValidPort(s.ssh.port)) errors['ssh.port'] = 'SSH port must be a number between 1 and 65535.';
    if (!s.ssh.user.trim()) errors['ssh.user'] = 'SSH proxy user is required.';
    if (s.ssh.auth === 'key' && !s.ssh.privateKeyPath.trim()) {
      errors['ssh.privateKeyPath'] = 'Private key file is required for key pair authentication.';
    }
  }
  if (s.ssl.enabled) {
    // Kafka and MongoDB clusters in the cloud use public CAs, which Node knows; the others need a CA file to verify.
    if (s.ssl.mode !== 'require' && !s.ssl.caFile.trim() && !PUBLIC_CA_ENGINES.has(s.engine)) {
      errors['ssl.caFile'] = 'CA file is required to verify the server certificate.';
    }
    if (s.ssl.certFile.trim() && !s.ssl.keyFile.trim()) errors['ssl.keyFile'] = 'Client key is required with a client certificate.';
    if (s.ssl.keyFile.trim() && !s.ssl.certFile.trim()) errors['ssl.certFile'] = 'Client certificate is required with a client key.';
  }

  const timeout = s.options.queryTimeout.trim();
  if (timeout && !/^\d+$/.test(timeout)) errors['options.queryTimeout'] = 'Query timeout must be a whole number of seconds.';

  const engine = getEngine(s.engine);
  const seen = new Set<string>();
  s.properties.forEach((p, i) => {
    const key = p.key.trim();
    const type = engine.driverOptions[key];
    if (!key) errors[`properties.${i}.key`] = 'Property name is required.';
    else if (Object.hasOwn(engine.reservedProperties, key)) {
      errors[`properties.${i}.key`] = `“${key}” is set on the ${engine.reservedProperties[key]} tab.`;
    } else if (!type) errors[`properties.${i}.key`] = `“${key}” is not a ${engine.driverLibrary} option.`;
    else if (seen.has(key)) errors[`properties.${i}.key`] = `“${key}” is listed more than once.`;
    else if (!isValidOptionValue(type, p.value)) errors[`properties.${i}.value`] = `“${key}” must be ${OPTION_TYPE_TEXT[type]}.`;
    seen.add(key);
  });
  return errors;
}

/** `host:port`, with an IPv6 address in brackets: `[::1]:9092`. */
export function parseHostPort(text: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(text.trim());
  if (!match || !isValidPort(match[2]!)) return null;
  return { host: match[1]!.replace(/^\[(.*)\]$/, '$1'), port: Number(match[2]) };
}

const REST_URLS = [
  ['schemaRegistryUrl', 'Schema Registry'],
  ['connectUrl', 'Kafka Connect'],
  ['ksqlDbUrl', 'ksqlDB'],
] as const;

function validateKafka(s: DataSourceSettings, errors: FieldErrors): void {
  const servers = bootstrapServerList(s.kafka);
  const wrong = servers.find((server) => !parseHostPort(server));
  if (!servers.length) errors['kafka.bootstrapServers'] = 'Bootstrap servers are required.';
  else if (wrong) errors['kafka.bootstrapServers'] = `“${wrong}” is not host:port, e.g. broker-1:9092.`;
  for (const [field, label] of REST_URLS) {
    const url = s.kafka[field].trim();
    if (url && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(url)) errors[`kafka.${field}`] = `${label} URL must start with http:// or https://.`;
  }
}

/** `host` or `host:port`; MongoDB fills in port 27017. */
function isHostOrHostPort(text: string): boolean {
  return /^(\[[^\]]+\]|[^:\s[\]/]+)$/.test(text) || parseHostPort(text) !== null;
}

function validateMongo(s: DataSourceSettings, errors: FieldErrors): void {
  const hosts = mongoHostList(s.mongo);
  if (!hosts.length) errors['mongo.hosts'] = 'Hosts are required.';
  else if (s.mongo.srv && (hosts.length > 1 || hosts[0]!.includes(':'))) {
    errors['mongo.hosts'] = 'An SRV connection names one host, without a port, e.g. cluster0.example.mongodb.net.';
  } else {
    const wrong = hosts.find((host) => !isHostOrHostPort(host));
    if (wrong) errors['mongo.hosts'] = `“${wrong}” is not host or host:port, e.g. mongo-1:27017.`;
  }
  // A tunnel reaches one server; replica set members and SRV records name others.
  if (s.ssh.enabled && (s.mongo.srv || hosts.length > 1)) errors['ssh.enabled'] = 'An SSH tunnel works with one host only, not with SRV or several hosts.';
}

const OPTION_TYPE_TEXT: Record<DriverOptionType, string> = {
  boolean: 'true or false',
  number: 'a number',
  string: 'text',
};

export function isValidOptionValue(type: DriverOptionType, value: string): boolean {
  const v = value.trim();
  if (type === 'boolean') return v === 'true' || v === 'false';
  if (type === 'number') return /^-?\d+(\.\d+)?$/.test(v);
  return true;
}
