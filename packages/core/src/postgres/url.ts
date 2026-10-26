import { ConnectionString, HostType } from 'connection-string';
import { cloneSettings, type DataSourceSettings, type SslMode } from '../dataSource';
import { getEngine } from '../engines';
import type { UrlParseResult } from '../url';
import { urlParams } from '../urlParams';

/**
 * The PostgreSQL connection URL, as libpq reads it: `postgresql://user@host:5432/shop?sslmode=verify-full&sslrootcert=…`.
 * Driver properties such as `application_name` and `options` (`-c search_path=shop`) are parameters too.
 * Passwords are read from a pasted URL but never written into one.
 */

const SCHEMES = new Set(['postgres', 'postgresql', 'jdbc:postgresql']);

/** libpq's `sslmode` values; `allow` and `prefer` would fall back to plain text, which this client does not do. */
const SSL_MODE_VALUES: Record<string, SslMode | 'off'> = {
  disable: 'off',
  allow: 'off',
  prefer: 'off',
  require: 'require',
  'verify-ca': 'verify-ca',
  'verify-full': 'verify-full',
};

export function buildPostgresUrl(s: DataSourceSettings): string {
  const params: Record<string, string> = {};
  if (s.ssl.enabled) {
    params.sslmode = s.ssl.mode;
    if (s.ssl.caFile.trim()) params.sslrootcert = s.ssl.caFile.trim();
    if (s.ssl.certFile.trim()) params.sslcert = s.ssl.certFile.trim();
    if (s.ssl.keyFile.trim()) params.sslkey = s.ssl.keyFile.trim();
  }
  for (const p of s.properties) if (p.key.trim()) params[p.key.trim()] = p.value;
  const host = s.host.trim();
  try {
    return new ConnectionString(null, {
      protocol: 'postgresql',
      user: s.user.trim() || undefined,
      hosts: host ? [{ name: host.includes(':') ? `[${host}]` : host, port: Number(s.port) || undefined }] : [],
      path: s.database.trim() ? [s.database.trim()] : [],
      params,
    }).toString();
  } catch {
    // Half-typed values (e.g. a host with spaces) cannot form a URL yet.
    return '';
  }
}

/** Fills the fields a PostgreSQL URL covers, starting from `base`; the SSH tunnel and the Options tab are kept. */
export function parsePostgresUrl(url: ConnectionString, base: DataSourceSettings): UrlParseResult {
  const engine = getEngine('postgres');
  const s = cloneSettings(base);
  if (url.protocol !== undefined && !SCHEMES.has(url.protocol.toLowerCase())) {
    return { ok: false, error: `Unsupported URL scheme “${url.protocol}://”. Use postgres:// or postgresql://.` };
  }
  const hosts = url.hosts ?? [];
  if (hosts.length > 1) return { ok: false, error: 'Only one host is supported.' };
  const path = url.path ?? [];
  if (path.length > 1) return { ok: false, error: 'The URL path can name one database only.' };

  const params = urlParams(url);
  const hostParam = params.take('host');
  if (hosts[0]?.type === HostType.socket || hostParam?.startsWith('/')) {
    return { ok: false, error: 'Unix sockets are not supported; connect over TCP, or through an SSH tunnel.' };
  }
  s.connectionType = 'tcp';
  s.host = (hostParam ?? hosts[0]?.name ?? 'localhost').replace(/^\[(.*)\]$/, '$1');
  s.port = String(params.take('port') ?? hosts[0]?.port ?? engine.defaultPort);
  s.database = params.take('dbname') ?? path[0] ?? '';

  const user = url.user ?? params.take('user');
  const password = url.password ?? params.take('password');
  if (user !== undefined) s.user = user;
  s.auth = password !== undefined || base.auth === 'password' ? 'password' : 'none';

  const sslMode = params.take('sslmode');
  const useSsl = params.take('ssl');
  const ca = params.take('sslrootcert');
  const cert = params.take('sslcert');
  const key = params.take('sslkey');
  let mode: SslMode | 'off';
  if (sslMode !== undefined) {
    const value = SSL_MODE_VALUES[sslMode.toLowerCase()];
    if (!value) return { ok: false, error: `Unknown sslmode “${sslMode}”. Use disable, require, verify-ca or verify-full.` };
    mode = value;
  } else if (useSsl !== undefined) {
    if (useSsl !== 'true' && useSsl !== 'false') return { ok: false, error: `“ssl” must be true or false, not “${useSsl}”.` };
    mode = useSsl === 'true' ? 'require' : 'off';
  } else {
    // As libpq does with a root certificate, a CA means verification; client files mean TLS.
    mode = ca ? 'verify-ca' : cert || key ? 'require' : 'off';
  }
  s.ssl = mode === 'off' ? { ...s.ssl, enabled: false } : { enabled: true, mode, caFile: ca ?? '', certFile: cert ?? '', keyFile: key ?? '' };

  // libpq's connect_timeout is in seconds; pg's option is in milliseconds.
  const timeout = params.take('connect_timeout');
  const { properties, ignored } = params.rest(engine);
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout)) return { ok: false, error: `“connect_timeout” must be a whole number of seconds, not “${timeout}”.` };
    if (!properties.some((p) => p.key === 'connectionTimeoutMillis')) properties.push({ key: 'connectionTimeoutMillis', value: String(Number(timeout) * 1000) });
  }
  s.properties = properties;
  return password ? { ok: true, settings: s, password, ignored } : { ok: true, settings: s, ignored };
}
