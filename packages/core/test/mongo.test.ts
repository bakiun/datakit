import { describe, expect, it } from 'vitest';
import { buildConnectionUrl, createDataSourceSettings, describeEndpoint, needsPassword, parseConnectionUrl, validateDataSource, type DataSourceSettings } from '../src';

function mongo(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mongodb');
  s.name = 'shop';
  s.properties = [];
  patch(s);
  return s;
}

function parse(url: string, from = mongo()) {
  const result = parseConnectionUrl(url, from);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe('MongoDB settings', () => {
  it('starts without auth on localhost:27017', () => {
    const s = mongo();
    expect(needsPassword(s)).toBe(false);
    expect(describeEndpoint(s)).toBe('localhost:27017');
    expect(validateDataSource(s, [])).toEqual({});
    expect(describeEndpoint(mongo((s) => (s.mongo.hosts = 'm1:27017, m2:27017,m3')))).toBe('m1:27017 +2');
  });

  it('checks hosts, SRV and the SSH tunnel', () => {
    expect(validateDataSource(mongo((s) => (s.mongo.hosts = ' ')), [])['mongo.hosts']).toBe('Hosts are required.');
    expect(validateDataSource(mongo((s) => (s.mongo.hosts = 'm1:27017,m 2')), [])['mongo.hosts']).toContain('“m 2” is not host or host:port');
    expect(validateDataSource(mongo((s) => (s.mongo.hosts = 'm1,[::1]:27018')), [])).toEqual({});
    const srv = (hosts: string) =>
      validateDataSource(
        mongo((s) => {
          s.mongo.srv = true;
          s.mongo.hosts = hosts;
        }),
        [],
      )['mongo.hosts'];
    expect(srv('cluster0.example.mongodb.net')).toBeUndefined();
    expect(srv('cluster0.example.mongodb.net:27017')).toContain('one host, without a port');
    const tunnel = validateDataSource(
      mongo((s) => {
        s.mongo.hosts = 'm1,m2';
        s.ssh = { ...s.ssh, enabled: true, host: 'bastion', user: 'deploy', auth: 'agent' };
      }),
      [],
    );
    expect(tunnel['ssh.enabled']).toBe('An SSH tunnel works with one host only, not with SRV or several hosts.');
  });

  it('verifies TLS with Node’s CAs when no CA file is given', () => {
    const s = mongo((s) => (s.ssl = { enabled: true, mode: 'verify-full', caFile: '', certFile: '', keyFile: '' }));
    expect(validateDataSource(s, [])['ssl.caFile']).toBeUndefined();
  });
});

describe('MongoDB connection string', () => {
  it('builds a URL without the password', () => {
    const s = mongo((s) => {
      s.auth = 'password';
      s.user = 'app';
      s.database = 'shop';
      s.mongo.hosts = 'm1:27017,m2:27018';
      s.mongo.authSource = 'admin';
      s.mongo.replicaSet = 'rs0';
      s.properties = [{ key: 'appName', value: 'datakit' }];
    });
    expect(buildConnectionUrl(s)).toBe('mongodb://app@m1:27017,m2:27018/shop?authSource=admin&replicaSet=rs0&appName=datakit');
    const srv = mongo((s) => {
      s.mongo.srv = true;
      s.mongo.hosts = 'cluster0.ab1.mongodb.net';
      s.ssl = { enabled: true, mode: 'require', caFile: '', certFile: '', keyFile: '' };
    });
    expect(buildConnectionUrl(srv)).toBe('mongodb+srv://cluster0.ab1.mongodb.net?tls=true&tlsAllowInvalidCertificates=true');
  });

  it('reads an Atlas SRV string with its password and options', () => {
    const result = parse('mongodb+srv://app:s%40cret@cluster0.ab1.mongodb.net/shop?retryWrites=true&w=majority&appName=Cluster0&foo=1');
    expect(result.settings.mongo).toMatchObject({ srv: true, hosts: 'cluster0.ab1.mongodb.net', authSource: '', replicaSet: '' });
    expect([result.settings.auth, result.settings.user, result.password, result.settings.database]).toEqual(['password', 'app', 's@cret', 'shop']);
    // SRV connections use TLS unless the string turns it off.
    expect(result.settings.ssl).toMatchObject({ enabled: true, mode: 'verify-full' });
    expect(result.settings.properties).toEqual([
      { key: 'retryWrites', value: 'true' },
      { key: 'w', value: 'majority' },
      { key: 'appName', value: 'Cluster0' },
    ]);
    expect(result.ignored).toEqual(['foo']);
  });

  it('reads replica sets, TLS files and rejects other schemes', () => {
    const result = parse('mongodb://m1:27017,m2,[::1]:27018/?replicaSet=rs0&tls=true&tlsCAFile=/certs/ca.pem&tlsAllowInvalidHostnames=true');
    expect(result.settings.mongo.hosts).toBe('m1:27017,m2,[::1]:27018');
    expect(result.settings.auth).toBe('none');
    expect(result.settings.ssl).toEqual({ enabled: true, mode: 'verify-ca', caFile: '/certs/ca.pem', certFile: '', keyFile: '' });
    const wrong = parseConnectionUrl('mysql://h/db', mongo());
    expect(!wrong.ok && wrong.error).toBe('Unsupported URL scheme “mysql://”. Use mongodb:// or mongodb+srv://.');
  });
});
