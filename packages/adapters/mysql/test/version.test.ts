import { describe, expect, it } from 'vitest';
import { parseMysqlVersion } from '../src';

describe('parseMysqlVersion', () => {
  it('reads MySQL and MariaDB version strings', () => {
    expect(parseMysqlVersion('8.0.36')).toEqual({ product: 'MySQL', version: '8.0.36' });
    expect(parseMysqlVersion('8.4.3-log')).toEqual({ product: 'MySQL', version: '8.4.3' });
    expect(parseMysqlVersion('10.11.6-MariaDB-1:10.11.6+maria~ubu2204')).toEqual({ product: 'MariaDB', version: '10.11.6' });
    expect(parseMysqlVersion('5.5.5-10.6.12-MariaDB')).toEqual({ product: 'MariaDB', version: '10.6.12' });
  });
});
