import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { describeConnectionError, loadTlsFiles, openSshTunnel, type SshTunnel } from '@datakit/adapter-common';
import {
  describeEndpoint,
  getEngine,
  propertiesToObject,
  queryTimeoutSeconds,
  splitSqlStatements,
  type ConnectionTestResult,
  type DataSourceSettings,
  type Secrets,
} from '@datakit/core';
import pg from 'pg';
import { PgSession } from './session';
import { parsePostgresVersion } from './version';

/** Driver properties as pg options; text options such as `application_name` stay text even when they look like numbers. */
function propertyOptions(s: DataSourceSettings): Record<string, unknown> {
  const engine = getEngine('postgres');
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(propertiesToObject(s.properties))) {
    if (key in engine.reservedProperties) continue;
    options[key] = engine.driverOptions[key] === 'string' ? String(value) : value;
  }
  return options;
}

/** pg's TLS options for the SSH / SSL tab; behind a tunnel the certificate is still checked against the real host. */
async function tlsOptions(s: DataSourceSettings, tunnelled: boolean): Promise<ConnectionOptions> {
  const host = s.host.trim();
  const options: ConnectionOptions = { ...(await loadTlsFiles(s.ssl)), rejectUnauthorized: s.ssl.mode !== 'require' };
  // Verify CA checks the chain but not the host name.
  if (s.ssl.mode === 'verify-ca') options.checkServerIdentity = () => undefined;
  if (tunnelled) {
    if (!isIP(host)) options.servername = host;
    if (s.ssl.mode === 'verify-full') options.checkServerIdentity = (_, certificate) => checkServerIdentity(host, certificate);
  }
  return options;
}

export async function clientConfig(s: DataSourceSettings, secrets: Secrets, tunnelPort?: number): Promise<pg.ClientConfig> {
  const timeoutMs = queryTimeoutSeconds(s.options) * 1000;
  const config: pg.ClientConfig = {
    ...propertyOptions(s),
    host: tunnelPort ? '127.0.0.1' : s.host.trim(),
    port: tunnelPort ?? Number(s.port),
    user: s.user.trim(),
    database: s.database.trim() || undefined,
    ssl: s.ssl.enabled ? await tlsOptions(s, tunnelPort !== undefined) : false,
  };
  if (s.auth === 'password') config.password = secrets.password ?? '';
  // The server stops a statement that runs longer; 0 leaves the server's own setting.
  if (timeoutMs > 0) config.statement_timeout = timeoutMs;
  return config;
}

/** A short message for connection failures; server errors such as a failed password check keep their text. */
function describePgConnectionError(error: unknown, target: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  // pg says `timeout expired`, or that the connection was terminated due to a connection timeout.
  if (/^timeout expired$|connection timeout/i.test(message)) return new Error(`Connection timed out (${target}).`);
  if (/client password must be a string/i.test(message)) return new Error('The server asks for a password; set Authentication to User & Password.');
  return describeConnectionError(error, target);
}

/**
 * Runs what the Options tab asks for on every new connection. The transaction mode is not applied here: it
 * belongs to query consoles, and metadata reads must not hold a transaction snapshot.
 */
async function prepareSession(client: pg.Client, s: DataSourceSettings): Promise<void> {
  if (s.options.readOnly) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  for (const statement of splitSqlStatements(s.options.initSql, 'postgres')) {
    try {
      await client.query(statement);
    } catch (error) {
      throw new Error(`“Run on connect” failed: ${(error as Error).message}`);
    }
  }
}

/** Opens a session with the settings and secrets of a data source; the SSH tunnel is opened first when enabled. */
export async function openPostgresSession(s: DataSourceSettings, secrets: Secrets): Promise<PgSession> {
  const target = describeEndpoint(s);
  const tunnel: SshTunnel | undefined = s.ssh.enabled ? await openSshTunnel(s.ssh, secrets) : undefined;
  try {
    const port = tunnel ? await tunnel.listen(s.host.trim(), Number(s.port)) : undefined;
    const client = new pg.Client(await clientConfig(s, secrets, port));
    // Errors before the session listens would otherwise go unhandled.
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw describePgConnectionError(error, target);
    }
    try {
      await prepareSession(client, s);
      const { rows } = await client.query<{ version: string; database: string; pid: number }>(
        `SELECT current_setting('server_version') AS version, current_database() AS database, pg_backend_pid() AS pid`,
      );
      const info = rows[0]!;
      return new PgSession(client, tunnel, parsePostgresVersion(info.version), info.database, Number(info.pid));
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    tunnel?.close();
    throw error;
  }
}

/** Connects, runs the session setup, reads the server version and disconnects. */
export async function testPostgresConnection(s: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult> {
  const started = performance.now();
  const session = await openPostgresSession(s, secrets);
  const latencyMs = Math.round(performance.now() - started);
  await session.close();
  return { serverVersion: session.serverVersion, latencyMs };
}
