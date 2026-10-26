import { describe, expect, it } from 'vitest';
import { createDataSourceSettings, sectionOf, validateDataSource, type DataSourceSettings } from '../src';

function settings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mysql');
  s.name = 'shop-dev';
  patch(s);
  return s;
}

describe('validateDataSource', () => {
  it('accepts the defaults once a name is set', () => {
    expect(validateDataSource(settings(), [])).toEqual({});
  });

  it('requires a unique name, ignoring case and spaces', () => {
    expect(validateDataSource(settings((s) => (s.name = ' ')), []).name).toBe('Name is required.');
    expect(validateDataSource(settings(), ['Shop-Dev ']).name).toContain('already named');
  });

  it('checks host and port for TCP and the path for sockets', () => {
    const tcp = validateDataSource(
      settings((s) => {
        s.host = '';
        s.port = '70000';
      }),
      [],
    );
    expect(Object.keys(tcp)).toEqual(['host', 'port']);
    const socket = validateDataSource(
      settings((s) => {
        s.connectionType = 'socket';
        s.host = '';
      }),
      [],
    );
    expect(Object.keys(socket)).toEqual(['socketPath']);
  });

  it('requires a user only for password authentication', () => {
    expect(validateDataSource(settings((s) => (s.user = '')), []).user).toBeDefined();
    expect(
      validateDataSource(
        settings((s) => {
          s.user = '';
          s.auth = 'none';
        }),
        [],
      ),
    ).toEqual({});
  });

  it('validates the SSH tunnel and TLS files only when enabled', () => {
    const errors = validateDataSource(
      settings((s) => {
        s.ssh.enabled = true;
        s.ssl.enabled = true;
        s.ssl.mode = 'verify-ca';
        s.ssl.certFile = '/tmp/client.pem';
      }),
      [],
    );
    expect(Object.keys(errors).sort()).toEqual(['ssh.host', 'ssh.privateKeyPath', 'ssh.user', 'ssl.caFile', 'ssl.keyFile']);
    expect(validateDataSource(settings((s) => (s.ssh.host = '')), [])).toEqual({});
  });

  it('rejects empty, duplicate and reserved driver properties', () => {
    const errors = validateDataSource(
      settings((s) => {
        s.properties = [
          { key: '', value: '1' },
          { key: 'charset', value: 'utf8mb4' },
          { key: 'charset', value: 'latin1' },
          { key: 'password', value: 'x' },
        ];
      }),
      [],
    );
    expect(errors['properties.0.key']).toBe('Property name is required.');
    expect(errors['properties.1.key']).toBeUndefined();
    expect(errors['properties.2.key']).toContain('more than once');
    expect(errors['properties.3.key']).toBe('“password” is set on the General tab.');
  });

  it('accepts only mysql2 options, with values of the right type', () => {
    const errors = validateDataSource(
      settings((s) => {
        s.properties = [
          { key: 'serverTimezone', value: 'UTC' },
          { key: 'multipleStatements', value: 'yes' },
          { key: 'connectTimeout', value: 'soon' },
          { key: 'timezone', value: 'Z' },
        ];
      }),
      [],
    );
    expect(errors).toEqual({
      'properties.0.key': '“serverTimezone” is not a mysql2 option.',
      'properties.1.value': '“multipleStatements” must be true or false.',
      'properties.2.value': '“connectTimeout” must be a number.',
    });
  });

  it('accepts an empty or whole-number query timeout', () => {
    expect(validateDataSource(settings((s) => (s.options.queryTimeout = '30')), [])).toEqual({});
    expect(validateDataSource(settings((s) => (s.options.queryTimeout = '1.5')), [])['options.queryTimeout']).toBeDefined();
  });
});

describe('sectionOf', () => {
  it('maps fields to form tabs', () => {
    expect(sectionOf('name')).toBeNull();
    expect(sectionOf('port')).toBe('general');
    expect(sectionOf('ssl.caFile')).toBe('ssh');
    expect(sectionOf('options.queryTimeout')).toBe('options');
    expect(sectionOf('properties.1.key')).toBe('advanced');
  });
});

describe('validateDataSource for Redis', () => {
  const redis = () => ({ ...createDataSourceSettings('redis'), name: 'cache' });

  it('needs a user only for ACL and a database index', () => {
    expect(validateDataSource(redis(), [])).toEqual({});
    expect(validateDataSource({ ...redis(), auth: 'acl' }, [])).toEqual({ user: 'User is required.' });
    expect(validateDataSource({ ...redis(), database: 'one' }, [])).toEqual({ database: 'Database index must be a whole number, e.g. 0.' });
    expect(validateDataSource({ ...createDataSourceSettings('mysql'), name: 'x', auth: 'acl' }, [])).toMatchObject({ auth: 'Pick an authentication method.' });
  });

  it('checks Redis driver properties', () => {
    const s = { ...redis(), properties: [{ key: 'scanCount', value: 'many' }, { key: 'keyPrefix', value: 'app:' }] };
    expect(validateDataSource(s, [])).toEqual({
      'properties.0.value': '“scanCount” must be a number.',
      'properties.1.key': '“keyPrefix” is not a node-redis option.',
    });
  });
});
