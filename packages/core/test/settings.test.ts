import { describe, expect, it } from 'vitest';
import {
  coercePropertyValue,
  createDataSourceSettings,
  propertiesToObject,
  queryTimeoutSeconds,
  shortServerVersion,
  splitSqlStatements,
  toSettings,
} from '../src';

describe('driver properties', () => {
  it('turns booleans and numbers into typed values', () => {
    expect(coercePropertyValue('true')).toBe(true);
    expect(coercePropertyValue(' false ')).toBe(false);
    expect(coercePropertyValue('10000')).toBe(10000);
    expect(coercePropertyValue('Z')).toBe('Z');
    expect(propertiesToObject([{ key: ' charset ', value: 'utf8mb4' }, { key: '', value: 'x' }])).toEqual({ charset: 'utf8mb4' });
  });
});

describe('settings helpers', () => {
  it('defaults the query timeout to 60 seconds', () => {
    const s = createDataSourceSettings('mysql');
    expect(queryTimeoutSeconds(s.options)).toBe(60);
    s.options.queryTimeout = '5';
    expect(queryTimeoutSeconds(s.options)).toBe(5);
  });

  it('drops the id and copies deeply', () => {
    const ds = { ...createDataSourceSettings('mysql'), id: 'a' };
    const settings = toSettings(ds);
    expect('id' in settings).toBe(false);
    settings.ssh.host = 'changed';
    expect(ds.ssh.host).toBe('');
  });

  it('shortens server versions', () => {
    expect(shortServerVersion({ product: 'MySQL', version: '8.0.36' })).toBe('mysql 8.0');
    expect(shortServerVersion({ product: 'MariaDB', version: '11' })).toBe('mariadb 11');
  });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons outside strings and comments', () => {
    expect(splitSqlStatements("SET time_zone = '+03:00';\n-- note; here\nSET @a = 'x;y';  ;", 'mysql')).toEqual([
      "SET time_zone = '+03:00'",
      "-- note; here\nSET @a = 'x;y'",
    ]);
  });
});
