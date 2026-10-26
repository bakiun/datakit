import { ConnectionString, HostType, type IHost } from 'connection-string';
import { cloneSettings, type DataSourceSettings, type MysqlDriver, type SslMode } from './dataSource';
import { getEngine } from './engines';
import { buildKafkaClientConfig, parseKafkaClientConfig } from './kafka/clientConfig';
import { buildMongoUrl, parseMongoUrl } from './mongo/url';
import { buildPostgresUrl, parsePostgresUrl } from './postgres/url';
import { buildRedisUrl, parseRedisUrl } from './redis/url';
import { urlParams } from './urlParams';

/**
 * The connection URL under the General tab. It covers the driver, host or socket, user, database,
 * TLS and the driver properties: `mysql://user@host:3306/db?ssl-mode=VERIFY_CA&ssl-ca=…&connectTimeout=5000`.
 * Passwords are read from a pasted URL but never written into one.
 */

const SCHEMES: Record<string, MysqlDriver> = {
  mysql: 'mysql',
  'jdbc:mysql': 'mysql',
  mariadb: 'mariadb',
  'jdbc:mariadb': 'mariadb',
};

const SSL_MODE_PARAM: Record<SslMode, string> = {
  require: 'REQUIRED',
  'verify-ca': 'VERIFY_CA',
  'verify-full': 'VERIFY_IDENTITY',
};

/** `ssl-mode` values, MySQL style first; `off` turns TLS off. PREFERRED cannot fall back to plain text here. */
const SSL_MODE_VALUES: Record<string, SslMode | 'off'> = {
  DISABLED: 'off',
  PREFERRED: 'off',
  REQUIRED: 'require',
  REQUIRE: 'require',
  VERIFY_CA: 'verify-ca',
  VERIFY_IDENTITY: 'verify-full',
  VERIFY_FULL: 'verify-full',
};

export function buildConnectionUrl(s: DataSourceSettings): string {
  if (s.engine === 'redis') return buildRedisUrl(s);
  if (s.engine === 'kafka') return buildKafkaClientConfig(s);
  if (s.engine === 'mongodb') return buildMongoUrl(s);
  if (s.engine === 'postgres') return buildPostgresUrl(s);
  const params: Record<string, string> = {};
  if (s.ssl.enabled) {
    params['ssl-mode'] = SSL_MODE_PARAM[s.ssl.mode];
    if (s.ssl.caFile.trim()) params['ssl-ca'] = s.ssl.caFile.trim();
    if (s.ssl.certFile.trim()) params['ssl-cert'] = s.ssl.certFile.trim();
    if (s.ssl.keyFile.trim()) params['ssl-key'] = s.ssl.keyFile.trim();
  }
  for (const p of s.properties) if (p.key.trim()) params[p.key.trim()] = p.value;

  const host: IHost =
    s.connectionType === 'socket'
      ? { name: s.socketPath.trim(), type: HostType.socket }
      : { name: s.host.includes(':') ? `[${s.host.trim()}]` : s.host.trim(), port: Number(s.port) || undefined };
  try {
    return new ConnectionString(null, {
      protocol: s.driver === 'mariadb' ? 'mariadb' : 'mysql',
      user: s.auth === 'password' && s.user ? s.user : undefined,
      hosts: host.name ? [host] : [],
      path: s.database ? [s.database] : [],
      params,
    }).toString();
  } catch {
    // Half-typed values (e.g. a host with spaces) cannot form a URL yet.
    return '';
  }
}

export type UrlParseResult =
  | { ok: true; settings: DataSourceSettings; password?: string; ignored: string[] }
  | { ok: false; error: string };

/**
 * Fills the fields a URL covers, starting from `base`; the SSH tunnel and the Options tab are kept.
 * Parameters that are not TLS settings or driver options are returned in `ignored`.
 */
export function parseConnectionUrl(text: string, base: DataSourceSettings): UrlParseResult {
  if (base.engine === 'kafka') return parseKafkaClientConfig(text, base);
  let url: ConnectionString;
  try {
    // File paths in parameters (`ssl-ca=/certs/ca.pem`) are often pasted unencoded; their slashes would end the query.
    url = new ConnectionString(text.trim().replace(/\?(.*)$/s, (_, query: string) => `?${query.replace(/\//g, '%2F')}`));
  } catch (error) {
    return { ok: false, error: `Invalid URL: ${(error as Error).message}` };
  }
  if (base.engine === 'redis') return parseRedisUrl(url, base);
  if (base.engine === 'mongodb') return parseMongoUrl(url, base);
  if (base.engine === 'postgres') return parsePostgresUrl(url, base);
  const engine = getEngine(base.engine);
  const s = cloneSettings(base);

  if (url.protocol !== undefined) {
    const driver = SCHEMES[url.protocol.toLowerCase()];
    if (!driver) return { ok: false, error: `Unsupported URL scheme “${url.protocol}://”. Use mysql:// or mariadb://.` };
    s.driver = driver;
  }
  const hosts = url.hosts ?? [];
  if (hosts.length > 1) return { ok: false, error: 'Only one host is supported.' };
  const path = url.path ?? [];
  if (path.length > 1) return { ok: false, error: 'The URL path can name one database only.' };

  // Parameter names are matched case-insensitively.
  const params = urlParams(url);
  const take = params.take;

  const host = hosts[0];
  const socket = take('socket', 'socketPath');
  if (socket !== undefined || host?.type === HostType.socket) {
    s.connectionType = 'socket';
    s.socketPath = socket ?? host?.name ?? '';
  } else {
    s.connectionType = 'tcp';
    s.host = (host?.name ?? 'localhost').replace(/^\[(.*)\]$/, '$1');
    s.port = String(host?.port ?? engine.defaultPort);
  }

  const user = url.user ?? take('user');
  const password = url.password ?? take('password');
  if (user) {
    s.auth = 'password';
    s.user = user;
  } else {
    s.auth = 'none';
  }
  s.database = path[0] ?? '';

  const sslMode = take('ssl-mode', 'sslMode');
  const useSsl = take('ssl', 'useSSL');
  const ca = take('ssl-ca', 'sslCa');
  const cert = take('ssl-cert', 'sslCert');
  const key = take('ssl-key', 'sslKey');
  let mode: SslMode | 'off';
  if (sslMode !== undefined) {
    const value = SSL_MODE_VALUES[sslMode.toUpperCase().replace(/-/g, '_')];
    if (!value) return { ok: false, error: `Unknown ssl-mode “${sslMode}”. Use DISABLED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY.` };
    mode = value;
  } else if (useSsl !== undefined) {
    if (useSsl !== 'true' && useSsl !== 'false') return { ok: false, error: `“ssl” must be true or false, not “${useSsl}”.` };
    mode = useSsl === 'true' ? 'require' : 'off';
  } else {
    // As in the mysql client: a CA implies verification, client files imply TLS.
    mode = ca ? 'verify-ca' : cert || key ? 'require' : 'off';
  }
  s.ssl.enabled = mode !== 'off';
  if (mode !== 'off') s.ssl = { enabled: true, mode, caFile: ca ?? '', certFile: cert ?? '', keyFile: key ?? '' };

  const { properties, ignored } = params.rest(engine);
  s.properties = properties;

  return password ? { ok: true, settings: s, password, ignored } : { ok: true, settings: s, ignored };
}
