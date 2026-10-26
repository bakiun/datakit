import { performance } from 'node:perf_hooks';
import { describeConnectionError, loadTlsFiles, openSshTunnel, type SshTunnel } from '@datakit/adapter-common';
import {
  describeEndpoint,
  propertiesToObject,
  queryTimeoutSeconds,
  splitSqlStatements,
  type ConnectionTestResult,
  type DataSourceSettings,
  type Secrets,
} from '@datakit/core';
import mysql, { type Connection, type ConnectionOptions, type RowDataPacket } from 'mysql2/promise';
import { MysqlSession } from './session';
import { parseMysqlVersion } from './version';

async function connectionOptions(s: DataSourceSettings, secrets: Secrets, tunnel?: SshTunnel): Promise<ConnectionOptions> {
  const options: ConnectionOptions = {
    // Show values as the server returns them: no time zone shifts, float rounding or JSON reformatting.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    jsonStrings: true,
    ...propertiesToObject(s.properties),
    database: s.database.trim() || undefined,
  };
  if (s.auth === 'password') {
    options.user = s.user.trim();
    options.password = secrets.password ?? '';
  }
  if (s.connectionType === 'socket') {
    options.socketPath = s.socketPath.trim();
  } else {
    // The host stays set behind a tunnel: TLS checks the certificate against it.
    options.host = s.host.trim();
    options.port = Number(s.port);
    if (tunnel) options.stream = await tunnel.forward(options.host, options.port);
  }
  if (s.ssl.enabled) {
    const files = await loadTlsFiles(s.ssl);
    options.ssl = {
      ...files,
      rejectUnauthorized: s.ssl.mode !== 'require',
      verifyIdentity: s.ssl.mode === 'verify-full',
    };
  }
  return options;
}

/**
 * Runs what the Options tab asks for on every new connection. The transaction mode is not applied
 * here: it belongs to query consoles, and metadata reads must not hold a transaction snapshot.
 */
async function prepareSession(connection: Connection, s: DataSourceSettings): Promise<void> {
  if (s.options.readOnly) await connection.query('SET SESSION TRANSACTION READ ONLY');
  for (const statement of splitSqlStatements(s.options.initSql, 'mysql')) {
    try {
      await connection.query(statement);
    } catch (error) {
      throw new Error(`“Run on connect” failed: ${(error as Error).message}`);
    }
  }
}

/** Opens a session with the settings and secrets of a data source; the SSH tunnel is opened first when enabled. */
export async function openMysqlSession(s: DataSourceSettings, secrets: Secrets): Promise<MysqlSession> {
  const target = describeEndpoint(s);
  const tunnel = s.ssh.enabled ? await openSshTunnel(s.ssh, secrets) : undefined;
  try {
    let connection: Connection;
    try {
      connection = await mysql.createConnection(await connectionOptions(s, secrets, tunnel));
    } catch (error) {
      throw describeConnectionError(error, target);
    }
    try {
      await prepareSession(connection, s);
      const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
      const version = parseMysqlVersion(String(rows[0]?.version ?? ''));
      return new MysqlSession(connection, tunnel, version, queryTimeoutSeconds(s.options) * 1000);
    } catch (error) {
      connection.destroy();
      throw error;
    }
  } catch (error) {
    tunnel?.close();
    throw error;
  }
}

/** Connects, runs the session setup, reads the server version and disconnects. */
export async function testMysqlConnection(s: DataSourceSettings, secrets: Secrets): Promise<ConnectionTestResult> {
  const started = performance.now();
  const session = await openMysqlSession(s, secrets);
  const latencyMs = Math.round(performance.now() - started);
  await session.close();
  return { serverVersion: session.serverVersion, latencyMs };
}
