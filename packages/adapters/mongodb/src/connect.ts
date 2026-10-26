import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity } from 'node:tls';
import { describeConnectionError, loadTlsFiles, openSshTunnel, type SshTunnel } from '@datakit/adapter-common';
import {
  describeEndpoint,
  getEngine,
  mongoHostList,
  parseHostPort,
  propertiesToObject,
  type ConnectionTestResult,
  type DataSourceSettings,
  type Secrets,
  type ServerVersion,
} from '@datakit/core';
import { MongoClient, MongoNetworkTimeoutError, MongoServerError, type Document, type MongoClientOptions, type TopologyDescriptionChangedEvent } from 'mongodb';
import { MongoClientSession } from './session';

const DEFAULT_PORT = 27017;
const DEFAULT_TIMEOUT_MS = 10_000;

/** `host` or `host:port` from the Hosts field, with the brackets of an IPv6 address removed. */
function splitHost(text: string): { host: string; port: number } {
  const hostPort = parseHostPort(text);
  if (hostPort) return hostPort;
  return { host: text.replace(/^\[(.*)\]$/, '$1'), port: DEFAULT_PORT };
}

const urlHost = ({ host, port }: { host: string; port: number }) => `${host.includes(':') ? `[${host}]` : host}:${port}`;

/** The connection string without credentials or options: those go in the client options, where nothing needs escaping. */
export function connectionUrl(s: DataSourceSettings, tunnelPort?: number): string {
  if (tunnelPort) return `mongodb://127.0.0.1:${tunnelPort}/`;
  const hosts = mongoHostList(s.mongo);
  if (!hosts.length) throw new Error('Hosts are required.');
  if (s.mongo.srv) return `mongodb+srv://${hosts[0]}/`;
  return `mongodb://${hosts.map((host) => urlHost(splitHost(host))).join(',')}/`;
}

/** Driver properties as client options: the driver takes the URL option names, with values of the type it expects. */
function propertyOptions(s: DataSourceSettings): Record<string, unknown> {
  const engine = getEngine('mongodb');
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propertiesToObject(s.properties))) {
    if (key in engine.reservedProperties) continue;
    // The driver reads numbers and booleans from text too, and names a wrong value; a name such as `appName`
    // must stay text even when it looks like a number. `w` is a number or a name such as `majority`.
    options[key] = engine.driverOptions[key] === 'string' && key !== 'w' ? String(value) : value;
  }
  return options;
}

export async function clientOptions(s: DataSourceSettings, secrets: Secrets, tunnelPort?: number): Promise<MongoClientOptions> {
  const hosts = mongoHostList(s.mongo);
  const properties = propertyOptions(s);
  const options: MongoClientOptions = {
    serverSelectionTimeoutMS: DEFAULT_TIMEOUT_MS,
    connectTimeoutMS: DEFAULT_TIMEOUT_MS,
    ...properties,
    tls: s.ssl.enabled,
  };
  if (s.auth === 'password') {
    options.auth = { username: s.user.trim(), password: secrets.password ?? '' };
    options.authSource = s.mongo.authSource.trim() || s.database.trim() || 'admin';
  }
  if (s.mongo.replicaSet.trim()) options.replicaSet = s.mongo.replicaSet.trim();
  if (s.ssl.enabled) {
    Object.assign(options, await loadTlsFiles(s.ssl));
    if (s.ssl.mode === 'require') options.tlsAllowInvalidCertificates = true;
    // Verify CA checks the chain but not the host name.
    if (s.ssl.mode === 'verify-ca') options.tlsAllowInvalidHostnames = true;
    if (tunnelPort) {
      // Behind a tunnel the client connects to the local end; the certificate is still checked against the real host.
      const host = splitHost(hosts[0] ?? '').host;
      if (!isIP(host)) options.servername = host;
      if (s.ssl.mode === 'verify-full') options.checkServerIdentity = (_, certificate) => checkServerIdentity(host, certificate);
    }
  }
  if (tunnelPort) {
    options.directConnection = true;
  } else if (!s.mongo.srv && hosts.length === 1 && !options.replicaSet && !('directConnection' in properties) && !properties.loadBalanced) {
    // Like mongosh: one host without a replica set name is used as it is, even when it is a replica set member
    // whose advertised host names cannot be reached from here (e.g. a container).
    options.directConnection = true;
  }
  return options;
}

/** The Node error code under a driver error, e.g. ECONNREFUSED. */
function errnoCause(error: unknown): NodeJS.ErrnoException | undefined {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.code === 'string') return e as NodeJS.ErrnoException;
  }
  return undefined;
}

/** A short message for connection failures; server errors such as `Authentication failed.` keep their text. */
export function describeMongoConnectionError(error: unknown, target: string): Error {
  if (error instanceof MongoServerError) return error;
  if (error instanceof MongoNetworkTimeoutError) return new Error(`Connection timed out (${target}).`);
  const cause = errnoCause(error);
  if (cause) {
    const described = describeConnectionError(cause, target);
    if (described !== cause) return described;
  }
  const reason = (error as { reason?: { servers?: Map<string, { error?: unknown }> } }).reason;
  const serverError = reason?.servers ? [...reason.servers.values()].find((server) => server.error)?.error : undefined;
  if (serverError && serverError !== error) return describeMongoConnectionError(serverError, target);
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Connects and waits for server selection, but gives up as soon as every known server failed its first check:
 * a wrong host or port then fails at once instead of after the server selection timeout.
 */
async function connectFast(client: MongoClient, target: string): Promise<void> {
  const seeds = new Set(client.options.hosts.map(String));
  let failure: Error | undefined;
  let fail: () => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (fail = () => reject(failure)));
  const onTopology = (event: TopologyDescriptionChangedEvent) => {
    const servers = [...event.newDescription.servers.values()];
    const [first] = servers;
    if (!first || !servers.every((server) => server.error)) return;
    // A replica set names its members itself; name the member that failed when it is not one of the hosts typed.
    failure = describeMongoConnectionError(first.error, seeds.has(first.address) ? target : first.address);
    fail();
  };
  client.on('topologyDescriptionChanged', onTopology);
  const connecting = client.connect();
  connecting.catch(() => undefined);
  try {
    await Promise.race([connecting, failed]);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw failure ?? describeMongoConnectionError(error, target);
  } finally {
    client.off('topologyDescriptionChanged', onTopology);
  }
}

/** `Replica set rs0`, `Sharded cluster`, `Load balanced` or `Standalone`, from the reply to `hello`. */
export function describeTopology(hello: Document, loadBalanced: boolean): string {
  if (loadBalanced) return 'Load balanced';
  if (typeof hello.setName === 'string') return `Replica set ${hello.setName}`;
  if (hello.msg === 'isdbgrid') return 'Sharded cluster';
  return 'Standalone';
}

async function readServer(client: MongoClient): Promise<{ serverVersion: ServerVersion; topology: string }> {
  const admin = client.db('admin');
  // Servers before 4.4.2 only know the old name of `hello`.
  const [buildInfo, hello] = await Promise.all([admin.command({ buildInfo: 1 }), admin.command({ hello: 1 }).catch(() => admin.command({ isMaster: 1 }))]);
  return {
    serverVersion: { product: 'MongoDB', version: String(buildInfo.version ?? '') },
    topology: describeTopology(hello, client.options.loadBalanced),
  };
}

/** Opens a session with the settings and secrets of a data source; the SSH tunnel is opened first when enabled. */
export async function openMongoSession(s: DataSourceSettings, secrets: Secrets): Promise<MongoClientSession> {
  const target = describeEndpoint(s);
  const tunnel: SshTunnel | undefined = s.ssh.enabled ? await openSshTunnel(s.ssh, secrets) : undefined;
  try {
    let port: number | undefined;
    if (tunnel) {
      const { host, port: remotePort } = splitHost(mongoHostList(s.mongo)[0] ?? '');
      port = await tunnel.listen(host, remotePort);
    }
    const client = new MongoClient(connectionUrl(s, port), await clientOptions(s, secrets, port));
    await connectFast(client, target);
    try {
      const { serverVersion, topology } = await readServer(client);
      return new MongoClientSession(client, tunnel, serverVersion, topology, s.database.trim());
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    tunnel?.close();
    throw error;
  }
}

/** Connects, reads the server version and disconnects. */
export async function testMongoConnection(s: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult> {
  const started = performance.now();
  const session = await openMongoSession(s, secrets);
  const latencyMs = Math.round(performance.now() - started);
  await session.close();
  return { serverVersion: session.serverVersion, latencyMs };
}
