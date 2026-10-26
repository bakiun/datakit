import { performance } from 'node:perf_hooks';
import type { ConnectionOptions } from 'node:tls';
import { loadTlsFiles } from '@datakit/adapter-common';
import {
  bootstrapServerList,
  DEFAULT_KAFKA_CLIENT_ID,
  describeEndpoint,
  kafkaReleaseOfMetadataLevel,
  parseHostPort,
  propertiesToObject,
  type ConnectionTestResult,
  type DataSourceSettings,
  type KafkaSettings,
  type Secrets,
  type ServerVersion,
} from '@datakit/core';
import { Admin, apiVersionsV3, clientSoftwareName, clientSoftwareVersion, type BaseOptions, type SASLOptions } from '@platformatic/kafka';
import { describeKafkaError, hasKafkaError } from './errors';
import { KafkaConnectRestClient } from './kafkaConnect';
import { KsqlDbRestClient } from './ksqlDb';
import { anyConnection, brokerConnection, readCluster } from './raw';
import { baseUrl } from './rest';
import { SchemaRegistryRestClient } from './schemaRegistry';
import { KafkaClientSession, type KafkaRestClients } from './session';

/** Client options the form sets itself; driver properties with these names are ignored. */
const RESERVED = new Set(['bootstrapBrokers', 'clientId', 'sasl', 'tls', 'ssl']);
const DEFAULT_REST_TIMEOUT_MS = 30_000;

export async function clientOptions(s: DataSourceSettings, secrets: Secrets): Promise<BaseOptions> {
  const servers = bootstrapServerList(s.kafka);
  if (!servers.length) throw new Error('Bootstrap servers are required.');
  const bootstrapBrokers = servers.map((server) => {
    const broker = parseHostPort(server);
    if (!broker) throw new Error(`“${server}” is not host:port, e.g. broker-1:9092.`);
    return broker;
  });
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propertiesToObject(s.properties))) if (!RESERVED.has(key)) options[key] = value;
  if (s.auth !== 'none') {
    const mechanism = s.kafka.saslMechanism;
    const password = secrets.password ?? '';
    // OAUTHBEARER sends the token as it is; the other mechanisms log in with the user and password.
    const sasl: SASLOptions = mechanism === 'OAUTHBEARER' ? { mechanism, token: password } : { mechanism, username: s.user.trim(), password };
    options['sasl'] = sasl;
  }
  if (s.ssl.enabled) {
    const tls: ConnectionOptions = { ...(await loadTlsFiles(s.ssl)), rejectUnauthorized: s.ssl.mode !== 'require' };
    // Verify CA checks the chain but not the host name.
    if (s.ssl.mode === 'verify-ca') tls.checkServerIdentity = () => undefined;
    options['tls'] = tls;
  }
  return { ...options, clientId: s.kafka.clientId.trim() || DEFAULT_KAFKA_CLIENT_ID, bootstrapBrokers };
}

/** The REST services named on the data source. */
export function restClients(kafka: KafkaSettings, timeoutMs = DEFAULT_REST_TIMEOUT_MS): KafkaRestClients {
  const url = (value: string) => (value.trim() ? baseUrl(value) : null);
  const registry = url(kafka.schemaRegistryUrl);
  const connect = url(kafka.connectUrl);
  const ksqlDb = url(kafka.ksqlDbUrl);
  return {
    schemaRegistry: registry ? new SchemaRegistryRestClient(registry, timeoutMs) : null,
    connect: connect ? new KafkaConnectRestClient(connect, timeoutMs) : null,
    ksqlDb: ksqlDb ? new KsqlDbRestClient(ksqlDb, timeoutMs) : null,
  };
}

/**
 * Kafka does not send its version; a KRaft cluster sends the finalized `metadata.version` level in ApiVersions
 * (v3 and later), which names the release. Older clusters leave the version empty.
 */
async function readServerVersion(admin: Admin): Promise<ServerVersion> {
  // Each bootstrap broker is tried once: a wrong address fails at once instead of after the retries.
  const connection = await anyConnection(admin);
  try {
    const response = await apiVersionsV3.api.async(connection, clientSoftwareName, String(clientSoftwareVersion));
    const level = response.finalizedFeatures?.find((f) => f.name === 'metadata.version')?.maxVersionLevel;
    return { product: 'Kafka', version: level === undefined ? '' : (kafkaReleaseOfMetadataLevel(level) ?? '') };
  } catch (error) {
    if (hasKafkaError(error, 'UNSUPPORTED_VERSION')) return { product: 'Kafka', version: '' };
    throw error;
  }
}

/**
 * Reads the metadata and connects to an advertised broker, which fails when the advertised listeners cannot be
 * reached from here. Neither step waits for the driver's retries.
 */
async function checkAdvertisedBrokers(admin: Admin): Promise<void> {
  const [broker] = (await readCluster(admin, [])).brokers.values();
  if (!broker) return;
  try {
    await brokerConnection(admin, broker);
  } catch (error) {
    const address = `${broker.host}:${broker.port}`;
    throw new Error(`The cluster advertises its brokers as ${address}, which cannot be reached from here: ${describeKafkaError(error, address).message}`);
  }
}

/** Points at the likely cause when the client and the listener disagree on SASL or TLS. */
function withHint(error: Error, s: DataSourceSettings, target: string): Error {
  const message = error.message;
  if (message === 'Connection closed') return new Error(`The broker closed the connection (${target}). Check the security protocol: the listener may expect SASL or TLS.`);
  if (message.startsWith('Connection reset by the server') && s.ssl.enabled) return new Error(`${message} Check the security protocol: the listener may not use TLS.`);
  if (message.startsWith('Cannot find a suitable SASL mechanism')) return new Error(`${message} Check the SASL mechanism, and that the listener uses SASL.`);
  return error;
}

/** Opens a session with the settings and secrets of a data source. SSH tunnels are not used for Kafka. */
export async function openKafkaSession(s: DataSourceSettings, secrets: Secrets): Promise<KafkaClientSession> {
  const options = await clientOptions(s, secrets);
  const target = describeEndpoint(s);
  const admin = new Admin(options);
  try {
    const serverVersion = await readServerVersion(admin);
    await checkAdvertisedBrokers(admin);
    const timeout = typeof options.requestTimeout === 'number' && options.requestTimeout > 0 ? options.requestTimeout : DEFAULT_REST_TIMEOUT_MS;
    return new KafkaClientSession(admin, options, serverVersion, restClients(s.kafka, timeout), target);
  } catch (error) {
    await admin.close().catch(() => undefined);
    throw withHint(describeKafkaError(error, target), s, target);
  }
}

/** Connects, reads the server version and disconnects. */
export async function testKafkaConnection(s: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult> {
  const started = performance.now();
  const session = await openKafkaSession(s, secrets);
  const latencyMs = Math.round(performance.now() - started);
  await session.close();
  return { serverVersion: session.serverVersion, latencyMs };
}
