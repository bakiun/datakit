import { performance } from 'node:perf_hooks';
import type { ConnectionOptions } from 'node:tls';
import { describeConnectionError, loadTlsFiles, openSshTunnel, type SshTunnel } from '@datakit/adapter-common';
import { describeEndpoint, propertiesToObject, type ConnectionTestResult, type DataSourceSettings, type Secrets, type ServerVersion } from '@datakit/core';
import { createClient, RESP_TYPES, type RedisClientOptions, type RedisFunctions, type RedisModules, type RedisScripts } from 'redis';
import { RedisClientSession, type RawClient } from './session';
import { asString } from './values';

/** Advanced-tab properties that belong under node-redis' `socket` options. */
const SOCKET_PROPERTIES = new Set(['connectTimeout', 'socketTimeout', 'keepAlive', 'keepAliveInitialDelay', 'noDelay']);
/** Properties the key browser reads itself; node-redis does not know them. */
const BROWSER_PROPERTIES = new Set(['scanCount']);

type Options = RedisClientOptions<RedisModules, RedisFunctions, RedisScripts, 2>;

export async function clientOptions(s: DataSourceSettings, secrets: Secrets, tunnelPort?: number): Promise<Options> {
  const socket: Record<string, unknown> = {
    // Behind a tunnel the client connects to the local end; TLS still checks the certificate against the real host.
    host: tunnelPort ? '127.0.0.1' : s.host.trim(),
    port: tunnelPort ?? Number(s.port),
    // A browser should report a lost connection instead of retrying behind the user's back.
    reconnectStrategy: false,
  };
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propertiesToObject(s.properties))) {
    if (SOCKET_PROPERTIES.has(key)) socket[key] = value;
    else if (!BROWSER_PROPERTIES.has(key)) options[key] = value;
  }
  if (s.ssl.enabled) {
    const tls: ConnectionOptions = {
      ...(await loadTlsFiles(s.ssl)),
      servername: s.host.trim(),
      rejectUnauthorized: s.ssl.mode !== 'require',
    };
    // Verify CA checks the chain but not the host name.
    if (s.ssl.mode === 'verify-ca') tls.checkServerIdentity = () => undefined;
    Object.assign(socket, tls, { tls: true });
  }
  return {
    ...options,
    socket: socket as Options['socket'],
    ...(s.auth === 'acl' ? { username: s.user.trim() } : {}),
    ...(s.auth !== 'none' ? { password: secrets.password ?? '' } : {}),
    database: Number(s.database) || 0,
    // RESP2, like redis-cli: flat arrays the CLI shows as they come.
    RESP: 2,
  };
}

/** Reads the server product and version from INFO; Valkey reports itself beside the Redis version it is compatible with. */
export function parseRedisVersion(info: string): ServerVersion {
  const field = (name: string) => new RegExp(`^${name}:(.+)$`, 'm').exec(info)?.[1]?.trim();
  if (field('server_name') === 'valkey' && field('valkey_version')) return { product: 'Valkey', version: field('valkey_version')! };
  return { product: 'Redis', version: field('redis_version') ?? '' };
}

/** Opens a session with the settings and secrets of a data source; the SSH tunnel is opened first when enabled. */
export async function openRedisSession(s: DataSourceSettings, secrets: Secrets): Promise<RedisClientSession> {
  const target = describeEndpoint(s);
  const tunnel: SshTunnel | undefined = s.ssh.enabled ? await openSshTunnel(s.ssh, secrets) : undefined;
  try {
    const port = tunnel ? await tunnel.listen(s.host.trim(), Number(s.port)) : undefined;
    const base = createClient(await clientOptions(s, secrets, port));
    // Errors after connecting end the session; before that, connect() rejects with them.
    base.on('error', () => undefined);
    try {
      await base.connect();
    } catch (error) {
      base.destroy();
      throw describeConnectionError(error, target);
    }
    const client = base.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }) as unknown as RawClient;
    try {
      const version = parseRedisVersion(asString(await client.sendCommand(['INFO', 'server'])));
      return new RedisClientSession(client, tunnel, version, Number(s.database) || 0);
    } catch (error) {
      base.destroy();
      throw error;
    }
  } catch (error) {
    tunnel?.close();
    throw error;
  }
}

/** Connects, reads the server version and disconnects. */
export async function testRedisConnection(s: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult> {
  const started = performance.now();
  const session = await openRedisSession(s, secrets);
  const latencyMs = Math.round(performance.now() - started);
  await session.close();
  return { serverVersion: session.serverVersion, latencyMs };
}
