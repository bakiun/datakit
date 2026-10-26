import { describe, expect, it } from 'vitest';
import { buildConnectionUrl, createDataSourceSettings, parseConnectionUrl, type DataSourceSettings } from '../src';

function base(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mysql');
  s.name = 'shop';
  s.properties = [];
  patch(s);
  return s;
}

function parse(url: string, from = base()) {
  const result = parseConnectionUrl(url, from);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('buildConnectionUrl', () => {
  it('builds a MySQL URL without the password', () => {
    const s = base((s) => {
      s.user = 'app user';
      s.database = 'shop';
    });
    expect(buildConnectionUrl(s)).toBe('mysql://app%20user@localhost:3306/shop');
  });

  it('writes TLS settings and driver properties as parameters', () => {
    const s = base((s) => {
      s.ssl = { enabled: true, mode: 'verify-ca', caFile: '~/certs/ca.pem', certFile: '', keyFile: '' };
      s.properties = [{ key: 'connectTimeout', value: '5000' }];
    });
    expect(buildConnectionUrl(s)).toBe('mysql://root@localhost:3306?ssl-mode=VERIFY_CA&ssl-ca=~%2Fcerts%2Fca.pem&connectTimeout=5000');
  });

  it('covers sockets, MariaDB, IPv6 and no-auth', () => {
    const socket = base((s) => {
      s.driver = 'mariadb';
      s.connectionType = 'socket';
      s.socketPath = '/tmp/mysql.sock';
      s.auth = 'none';
    });
    expect(buildConnectionUrl(socket)).toBe('mariadb://%2Ftmp%2Fmysql.sock');
    expect(buildConnectionUrl(base((s) => (s.host = '::1')))).toBe('mysql://root@[::1]:3306');
  });

  it('copes with half-typed fields', () => {
    expect(buildConnectionUrl(base((s) => (s.port = 'abc')))).toBe('mysql://root@localhost');
    expect(buildConnectionUrl(base((s) => (s.host = '')))).toBe('mysql://root@');
  });
});

describe('parseConnectionUrl', () => {
  it('keeps unencoded file paths in parameters', () => {
    const { settings } = parse('mysql://h/db?ssl-mode=VERIFY_CA&ssl-ca=/certs/ca.pem');
    expect([settings.database, settings.ssl.caFile]).toEqual(['db', '/certs/ca.pem']);
  });

  it('fills host, port, user, password and database', () => {
    const result = parse('mysql://app:p%40ss@db.example.com:3307/shop');
    expect(result.settings).toMatchObject({ connectionType: 'tcp', host: 'db.example.com', port: '3307', auth: 'password', user: 'app', database: 'shop' });
    expect(result.password).toBe('p@ss');
    expect(result.ignored).toEqual([]);
  });

  it('uses the default port and localhost when they are missing', () => {
    expect(parse('mysql://root@/').settings).toMatchObject({ host: 'localhost', port: '3306' });
    expect(parse('mysql://root@db').settings.port).toBe('3306');
  });

  it('reads the driver from the scheme, JDBC included', () => {
    expect(parse('mariadb://u@h').settings.driver).toBe('mariadb');
    expect(parse('jdbc:mysql://u@h', base((s) => (s.driver = 'mariadb'))).settings.driver).toBe('mysql');
    expect(parse('u@h:3310/db').settings).toMatchObject({ driver: 'mysql', host: 'h', port: '3310' });
  });

  it('switches to no-auth when the URL has no user', () => {
    expect(parse('mysql://h/db').settings.auth).toBe('none');
    expect(parse('mysql://h/db?user=app&password=x')).toMatchObject({ settings: { auth: 'password', user: 'app' }, password: 'x' });
  });

  it('reads Unix sockets from the host or the socket parameter', () => {
    expect(parse('mysql://root@%2Ftmp%2Fmysql.sock/shop').settings).toMatchObject({ connectionType: 'socket', socketPath: '/tmp/mysql.sock' });
    expect(parse('mysql://root@localhost/shop?socket=%2Fvar%2Frun%2Fmysqld.sock').settings).toMatchObject({
      connectionType: 'socket',
      socketPath: '/var/run/mysqld.sock',
    });
  });

  it('reads TLS parameters', () => {
    expect(parse('mysql://u@h?ssl-mode=VERIFY_IDENTITY&ssl-ca=%2Fca.pem&ssl-cert=%2Fc.pem&ssl-key=%2Fk.pem').settings.ssl).toEqual({
      enabled: true,
      mode: 'verify-full',
      caFile: '/ca.pem',
      certFile: '/c.pem',
      keyFile: '/k.pem',
    });
    expect(parse('mysql://u@h?sslMode=required').settings.ssl).toMatchObject({ enabled: true, mode: 'require' });
    expect(parse('jdbc:mysql://u@h?useSSL=true').settings.ssl).toMatchObject({ enabled: true, mode: 'require' });
    expect(parse('mysql://u@h?ssl-ca=%2Fca.pem').settings.ssl).toMatchObject({ enabled: true, mode: 'verify-ca' });
    expect(parse('mysql://u@h?ssl-mode=DISABLED').settings.ssl.enabled).toBe(false);
    expect(parse('mysql://u@h', base((s) => (s.ssl.enabled = true))).settings.ssl.enabled).toBe(false);
  });

  it('turns mysql2 options into driver properties and reports the rest', () => {
    const result = parse('jdbc:mysql://u@h/db?connecttimeout=5000&charset=latin1&serverTimezone=UTC&useSSL=false');
    expect(result.settings.properties).toEqual([
      { key: 'connectTimeout', value: '5000' },
      { key: 'charset', value: 'latin1' },
    ]);
    expect(result.ignored).toEqual(['serverTimezone']);
    expect(result.settings.ssl.enabled).toBe(false);
  });

  it('keeps what the URL does not cover', () => {
    const from = base((s) => {
      s.name = 'kept';
      s.ssh.enabled = true;
      s.options.readOnly = true;
    });
    expect(parse('mysql://u@h', from).settings).toMatchObject({ name: 'kept', ssh: { enabled: true }, options: { readOnly: true } });
  });

  it('round-trips what it builds', () => {
    const s = base((s) => {
      s.driver = 'mariadb';
      s.host = 'db.internal';
      s.port = '3307';
      s.user = 'a@b';
      s.database = 'my db';
      s.ssl = { enabled: true, mode: 'verify-ca', caFile: '/ca.pem', certFile: '', keyFile: '' };
      s.properties = [{ key: 'multipleStatements', value: 'true' }];
    });
    expect(parse(buildConnectionUrl(s)).settings).toEqual(s);
  });

  it('explains what it cannot use', () => {
    const error = (url: string) => {
      const result = parseConnectionUrl(url, base());
      return result.ok ? null : result.error;
    };
    expect(error('postgres://h/db')).toBe('Unsupported URL scheme “postgres://”. Use mysql:// or mariadb://.');
    expect(error('mysql://h1,h2/db')).toBe('Only one host is supported.');
    expect(error('mysql://h/a/b')).toBe('The URL path can name one database only.');
    expect(error('mysql://h:99999')).toMatch(/^Invalid URL: Invalid port/);
    expect(error('mysql://h?ssl-mode=maybe')).toMatch(/^Unknown ssl-mode “maybe”/);
  });
});

describe('Redis URLs', () => {
  const redis = (patch: (s: DataSourceSettings) => void = () => {}) => {
    const s = createDataSourceSettings('redis');
    s.properties = [];
    patch(s);
    return s;
  };

  it('builds redis:// and rediss:// URLs with the database index and no password', () => {
    expect(buildConnectionUrl(redis())).toBe('redis://localhost:6379/0');
    const acl = redis((s) => {
      s.auth = 'acl';
      s.user = 'reader';
      s.database = '3';
      s.ssl.enabled = true;
      s.properties = [{ key: 'connectTimeout', value: '5000' }];
    });
    expect(buildConnectionUrl(acl)).toBe('rediss://reader@localhost:6379/3?connectTimeout=5000');
  });

  it('reads the user, the password alone, TLS and options', () => {
    const acl = parse('rediss://reader:s3cret@cache.internal:6380/2?connectTimeout=3000&foo=1', redis());
    expect(acl.settings).toMatchObject({ host: 'cache.internal', port: '6380', database: '2', auth: 'acl', user: 'reader' });
    expect(acl.settings.ssl.enabled).toBe(true);
    expect(acl.password).toBe('s3cret');
    expect(acl.settings.properties).toEqual([{ key: 'connectTimeout', value: '3000' }]);
    expect(acl.ignored).toEqual(['foo']);

    const passwordOnly = parse('redis://:s3cret@localhost', redis((s) => (s.auth = 'acl')));
    expect(passwordOnly.settings).toMatchObject({ auth: 'password', database: '0', port: '6379' });
    expect(passwordOnly.password).toBe('s3cret');
  });

  it('rejects other schemes and paths that are not a database index', () => {
    expect(parseConnectionUrl('mysql://root@localhost', redis())).toEqual({ ok: false, error: 'Unsupported URL scheme “mysql://”. Use redis:// or rediss://.' });
    expect(parseConnectionUrl('redis://localhost/shop', redis())).toEqual({ ok: false, error: 'The URL path is the database index, e.g. /0.' });
  });
});
