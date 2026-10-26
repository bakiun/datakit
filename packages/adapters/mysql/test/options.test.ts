import { getEngine } from '@datakit/core';
import mysql from 'mysql2/promise';
import { describe, expect, it, vi } from 'vitest';

describe('driver options', () => {
  it('lists only options mysql2 accepts', async () => {
    // mysql2 reports unknown options with console.error while it reads the configuration.
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const options = Object.fromEntries(Object.keys(getEngine('mysql').driverOptions).map((name) => [name, undefined]));
    await mysql.createConnection({ ...options, host: '127.0.0.1', port: 1 }).catch(() => undefined);
    const unknown = report.mock.calls.map((args) => String(args[0])).filter((m) => m.includes('invalid configuration option'));
    report.mockRestore();
    expect(unknown).toEqual([]);
  });
});
