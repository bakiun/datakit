import { ConnectionString, type IHost } from 'connection-string';
import { cloneSettings, type DataSourceSettings } from '../dataSource';
import { getEngine } from '../engines';
import type { UrlParseResult } from '../url';
import { urlParams } from '../urlParams';

/**
 * The Redis connection URL: `redis://[user@]host:6379/0`, `rediss://` with TLS, driver properties as parameters.
 * Passwords are read from a pasted URL but never written into one.
 */
export function buildRedisUrl(s: DataSourceSettings): string {
  const params: Record<string, string> = {};
  for (const p of s.properties) if (p.key.trim()) params[p.key.trim()] = p.value;
  const host: IHost = { name: s.host.includes(':') ? `[${s.host.trim()}]` : s.host.trim(), port: Number(s.port) || undefined };
  try {
    return new ConnectionString(null, {
      protocol: s.ssl.enabled ? 'rediss' : 'redis',
      user: s.auth === 'acl' && s.user.trim() ? s.user.trim() : undefined,
      hosts: host.name ? [host] : [],
      path: [s.database.trim() || '0'],
      params,
    }).toString();
  } catch {
    // Half-typed values (e.g. a host with spaces) cannot form a URL yet.
    return '';
  }
}

/** Fills the fields a Redis URL covers, starting from `base`; the SSH tunnel and the Options tab are kept. */
export function parseRedisUrl(url: ConnectionString, base: DataSourceSettings): UrlParseResult {
  const engine = getEngine('redis');
  const s = cloneSettings(base);
  const scheme = url.protocol?.toLowerCase();
  if (scheme !== undefined && scheme !== 'redis' && scheme !== 'rediss') {
    return { ok: false, error: `Unsupported URL scheme “${url.protocol}://”. Use redis:// or rediss://.` };
  }
  const hosts = url.hosts ?? [];
  if (hosts.length > 1) return { ok: false, error: 'Only one host is supported.' };
  const path = url.path ?? [];
  if (path.length > 1 || (path[0] !== undefined && !/^\d+$/.test(path[0]))) {
    return { ok: false, error: 'The URL path is the database index, e.g. /0.' };
  }
  s.host = (hosts[0]?.name ?? 'localhost').replace(/^\[(.*)\]$/, '$1');
  s.port = String(hosts[0]?.port ?? engine.defaultPort);
  s.database = path[0] ?? '0';

  const params = urlParams(url);
  const user = url.user ?? params.take('username', 'user');
  const password = url.password ?? params.take('password');
  if (user) {
    s.auth = 'acl';
    s.user = user;
  } else if (s.auth === 'acl' || password !== undefined) {
    s.auth = 'password';
  }
  if (scheme === 'rediss') s.ssl.enabled = true;
  else if (scheme === 'redis') s.ssl.enabled = false;

  const { properties, ignored } = params.rest(engine);
  s.properties = properties;
  return password ? { ok: true, settings: s, password, ignored } : { ok: true, settings: s, ignored };
}
