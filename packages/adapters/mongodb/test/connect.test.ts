import { createDataSourceSettings, type DataSourceSettings } from '@datakit/core';
import { describe, expect, it } from 'vitest';
import { clientOptions, connectionUrl, describeTopology } from '../src';

function settings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mongodb');
  patch(s);
  return s;
}

describe('connection options', () => {
  it('builds the URL from the hosts, with the default port and IPv6 brackets', () => {
    expect(connectionUrl(settings((s) => (s.mongo.hosts = 'a, b:27018,[::1],[fe80::1]:27019')))).toBe('mongodb://a:27017,b:27018,[::1]:27017,[fe80::1]:27019/');
    expect(connectionUrl(settings((s) => ((s.mongo.hosts = 'cluster0.example.net'), (s.mongo.srv = true))))).toBe('mongodb+srv://cluster0.example.net/');
    expect(connectionUrl(settings(), 40001)).toBe('mongodb://127.0.0.1:40001/');
  });

  it('logs in against the auth source, the default database or admin', async () => {
    const auth = (patch: (s: DataSourceSettings) => void) =>
      clientOptions(
        settings((s) => {
          s.auth = 'password';
          s.user = ' ada ';
          patch(s);
        }),
        { password: 'secret' },
      );
    expect(await auth(() => {})).toMatchObject({ auth: { username: 'ada', password: 'secret' }, authSource: 'admin' });
    expect((await auth((s) => (s.database = 'shop'))).authSource).toBe('shop');
    expect((await auth((s) => ((s.database = 'shop'), (s.mongo.authSource = 'users')))).authSource).toBe('users');
    expect(await clientOptions(settings(), {})).not.toHaveProperty('auth');
  });

  it('sets TLS, timeouts, the replica set and driver properties', async () => {
    expect(await clientOptions(settings(), {})).toEqual({ serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, tls: false, directConnection: true });
    const tls = (mode: DataSourceSettings['ssl']['mode']) => clientOptions(settings((s) => (s.ssl = { ...s.ssl, enabled: true, mode })), {});
    expect(await tls('require')).toMatchObject({ tls: true, tlsAllowInvalidCertificates: true });
    expect(await tls('verify-ca')).toMatchObject({ tls: true, tlsAllowInvalidHostnames: true });
    expect(await tls('verify-full')).not.toHaveProperty('tlsAllowInvalidHostnames');
    const tunneled = await clientOptions(settings((s) => ((s.mongo.hosts = 'db.internal:27017'), (s.ssl.enabled = true))), {}, 40001);
    expect(tunneled).toMatchObject({ servername: 'db.internal', directConnection: true });

    const replica = await clientOptions(settings((s) => (s.mongo.replicaSet = 'rs0')), {});
    expect(replica).toMatchObject({ replicaSet: 'rs0' });
    expect(replica).not.toHaveProperty('directConnection');
    expect(await clientOptions(settings((s) => (s.mongo.hosts = 'a,b')), {})).not.toHaveProperty('directConnection');

    const properties = await clientOptions(
      settings((s) => {
        s.properties = [
          { key: 'serverSelectionTimeoutMS', value: '2000' },
          { key: 'appName', value: '123' },
          { key: 'retryWrites', value: 'false' },
          { key: 'w', value: 'majority' },
          { key: 'directConnection', value: 'false' },
          { key: 'tls', value: 'true' },
        ];
      }),
      {},
    );
    expect(properties).toEqual({ serverSelectionTimeoutMS: 2000, connectTimeoutMS: 10_000, appName: '123', retryWrites: false, w: 'majority', directConnection: false, tls: false });
  });

  it('names the topology from the reply to hello', () => {
    expect(describeTopology({ setName: 'rs0' }, false)).toBe('Replica set rs0');
    expect(describeTopology({ msg: 'isdbgrid' }, false)).toBe('Sharded cluster');
    expect(describeTopology({ msg: 'isdbgrid' }, true)).toBe('Load balanced');
    expect(describeTopology({ isWritablePrimary: true }, false)).toBe('Standalone');
  });
});
