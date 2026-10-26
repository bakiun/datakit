import { KAFKA_SASL_MECHANISMS, KAFKA_SECURITY_PROTOCOLS } from '../choices';
import {
  bootstrapServerList,
  cloneSettings,
  kafkaSecurityProtocol,
  setKafkaSecurityProtocol,
  type DataSourceSettings,
  type KafkaSaslMechanism,
  type KafkaSecurityProtocol,
} from '../dataSource';
import type { UrlParseResult } from '../url';

/**
 * Kafka has no connection URL; the General tab shows the client config instead:
 * `bootstrap.servers=broker-1:9092 security.protocol=SASL_SSL sasl.mechanism=SCRAM-SHA-512`.
 * Pasting a client.properties file fills the fields. Passwords are read from `sasl.jaas.config` but never written.
 */
export function buildKafkaClientConfig(s: DataSourceSettings): string {
  const protocol = kafkaSecurityProtocol(s);
  const parts = [`bootstrap.servers=${bootstrapServerList(s.kafka).join(',')}`, `security.protocol=${protocol}`];
  if (protocol.startsWith('SASL_')) parts.push(`sasl.mechanism=${s.kafka.saslMechanism}`);
  return parts.join(' ');
}

/** Keys of Kafka client configs all contain a dot, which tells them from `username=` inside a JAAS value. */
const KEY = /(?:^|\s)([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\s*=/gi;

/** `key=value` pairs from client.properties text, one per line or separated by spaces; `#` starts a comment line. */
function readPairs(text: string): Map<string, string> {
  const body = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*[#!]/.test(line))
    .join('\n');
  const pairs = new Map<string, string>();
  const keys = [...body.matchAll(KEY)];
  keys.forEach((match, i) => {
    const start = match.index! + match[0].length;
    const end = keys[i + 1]?.index ?? body.length;
    pairs.set(match[1]!.toLowerCase(), body.slice(start, end).trim());
  });
  return pairs;
}

/** `username` and `password` of a JAAS login module, e.g. `… PlainLoginModule required username="app" password="x";`. */
function jaasCredentials(jaas: string): { user?: string; password?: string } {
  const field = (name: string) => new RegExp(`\\b${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(jaas)?.[1]?.replace(/\\(.)/g, '$1');
  return { user: field('username'), password: field('password') };
}

export function parseKafkaClientConfig(text: string, base: DataSourceSettings): UrlParseResult {
  const pairs = readPairs(text);
  if (!pairs.size) return { ok: false, error: 'Paste client settings as key=value, e.g. bootstrap.servers=broker-1:9092.' };
  const s = cloneSettings(base);
  const take = (key: string) => {
    const value = pairs.get(key);
    pairs.delete(key);
    return value;
  };

  const servers = take('bootstrap.servers');
  if (servers !== undefined) s.kafka.bootstrapServers = servers.replace(/\s+/g, '');
  const protocol = take('security.protocol');
  if (protocol !== undefined) {
    const value = protocol.toUpperCase() as KafkaSecurityProtocol;
    if (!KAFKA_SECURITY_PROTOCOLS.some((c) => c.value === value)) {
      return { ok: false, error: `Unknown security.protocol “${protocol}”. Use ${KAFKA_SECURITY_PROTOCOLS.map((c) => c.label).join(', ')}.` };
    }
    setKafkaSecurityProtocol(s, value);
  }
  const mechanism = take('sasl.mechanism') ?? take('sasl.mechanisms');
  if (mechanism !== undefined) {
    const value = mechanism.toUpperCase() as KafkaSaslMechanism;
    if (!KAFKA_SASL_MECHANISMS.some((c) => c.value === value)) {
      return { ok: false, error: `Unsupported sasl.mechanism “${mechanism}”. Use ${KAFKA_SASL_MECHANISMS.map((c) => c.label).join(', ')}.` };
    }
    s.kafka.saslMechanism = value;
  }
  const clientId = take('client.id');
  if (clientId !== undefined) s.kafka.clientId = clientId;
  const registry = take('schema.registry.url');
  if (registry !== undefined) s.kafka.schemaRegistryUrl = registry;

  const jaas = take('sasl.jaas.config');
  const credentials = jaas === undefined ? {} : jaasCredentials(jaas);
  // librdkafka names them directly.
  const user = credentials.user ?? take('sasl.username');
  const password = credentials.password ?? take('sasl.password');
  if (user !== undefined) s.user = user;

  const ignored = [...pairs.keys()];
  return password !== undefined ? { ok: true, settings: s, password, ignored } : { ok: true, settings: s, ignored };
}
