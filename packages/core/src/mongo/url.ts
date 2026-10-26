import { ConnectionString, type IHost } from 'connection-string';
import { cloneSettings, mongoHostList, type DataSourceSettings, type SslMode } from '../dataSource';
import { getEngine } from '../engines';
import type { UrlParseResult } from '../url';
import { urlParams } from '../urlParams';

/**
 * The MongoDB connection string: `mongodb://user@host1:27017,host2:27017/shop?authSource=admin&replicaSet=rs0`, or
 * `mongodb+srv://user@cluster0.example.mongodb.net/shop`. TLS settings and driver properties are parameters.
 * Passwords are read from a pasted URL but never written into one.
 */

/** How lax certificate checks are, by the TLS parameter that turns them off. */
const TLS_RELAXED: Record<SslMode, Record<string, string>> = {
  require: { tlsAllowInvalidCertificates: 'true' },
  'verify-ca': { tlsAllowInvalidHostnames: 'true' },
  'verify-full': {},
};

function hostOf(text: string): IHost {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(text);
  const name = match?.[1] ?? text;
  const port = match?.[2] ? Number(match[2]) : undefined;
  return port === undefined ? { name } : { name, port };
}

export function buildMongoUrl(s: DataSourceSettings): string {
  const params: Record<string, string> = {};
  if (s.mongo.authSource.trim()) params.authSource = s.mongo.authSource.trim();
  if (s.mongo.replicaSet.trim()) params.replicaSet = s.mongo.replicaSet.trim();
  if (s.ssl.enabled) {
    params.tls = 'true';
    Object.assign(params, TLS_RELAXED[s.ssl.mode]);
    if (s.ssl.caFile.trim()) params.tlsCAFile = s.ssl.caFile.trim();
  }
  for (const p of s.properties) if (p.key.trim()) params[p.key.trim()] = p.value;
  try {
    return new ConnectionString(null, {
      protocol: s.mongo.srv ? 'mongodb+srv' : 'mongodb',
      user: s.auth === 'password' && s.user.trim() ? s.user.trim() : undefined,
      hosts: mongoHostList(s.mongo).map(hostOf),
      path: s.database.trim() ? [s.database.trim()] : [],
      params,
    }).toString();
  } catch {
    // Half-typed values (e.g. a host with spaces) cannot form a URL yet.
    return '';
  }
}

/** Fills the fields a MongoDB URL covers, starting from `base`; the SSH tunnel and the Options tab are kept. */
export function parseMongoUrl(url: ConnectionString, base: DataSourceSettings): UrlParseResult {
  const engine = getEngine('mongodb');
  const s = cloneSettings(base);
  const scheme = url.protocol?.toLowerCase();
  if (scheme !== undefined && scheme !== 'mongodb' && scheme !== 'mongodb+srv') {
    return { ok: false, error: `Unsupported URL scheme “${url.protocol}://”. Use mongodb:// or mongodb+srv://.` };
  }
  const path = url.path ?? [];
  if (path.length > 1) return { ok: false, error: 'The URL path can name one database only.' };
  if (scheme !== undefined) s.mongo.srv = scheme === 'mongodb+srv';
  const hosts = url.hosts ?? [];
  if (hosts.length) s.mongo.hosts = hosts.map((h) => (h.port ? `${h.name}:${h.port}` : h.name)).join(',');
  s.database = path[0] ?? '';

  const params = urlParams(url);
  const user = url.user ?? params.take('username');
  const password = url.password ?? params.take('password');
  if (user) {
    s.auth = 'password';
    s.user = user;
  } else {
    s.auth = 'none';
  }
  s.mongo.authSource = params.take('authSource') ?? '';
  s.mongo.replicaSet = params.take('replicaSet') ?? '';

  const tls = params.take('tls', 'ssl');
  const ca = params.take('tlsCAFile');
  const certKey = params.take('tlsCertificateKeyFile');
  const insecure = params.take('tlsInsecure') === 'true' || params.take('tlsAllowInvalidCertificates') === 'true';
  const anyHost = params.take('tlsAllowInvalidHostnames') === 'true';
  if (tls !== undefined && tls !== 'true' && tls !== 'false') return { ok: false, error: `“tls” must be true or false, not “${tls}”.` };
  // SRV connections use TLS unless told otherwise.
  const enabled = tls === undefined ? s.mongo.srv || !!ca || !!certKey : tls === 'true';
  s.ssl = enabled
    ? { enabled, mode: insecure ? 'require' : anyHost ? 'verify-ca' : 'verify-full', caFile: ca ?? '', certFile: certKey ?? '', keyFile: certKey ?? '' }
    : { ...s.ssl, enabled };

  const { properties, ignored } = params.rest(engine);
  s.properties = properties;
  return password ? { ok: true, settings: s, password, ignored } : { ok: true, settings: s, ignored };
}
