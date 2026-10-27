import { describe, expect, it } from 'vitest';
import {
  describeReply,
  editProblem,
  formatCommand,
  formatReply,
  formatScanCommand,
  LIST_CHANGED,
  parseScanCommand,
  planEdit,
  redisTextLabel,
  splitCommandLine,
  type RedisReply,
} from '../src';

describe('planEdit', () => {
  it('writes strings with KEEPTTL, or the TTL again on old servers', () => {
    expect(planEdit({ kind: 'setString', key: 'k', value: 'v', ttl: 30, keepTtl: true }).commands).toEqual([['SET', 'k', 'v', 'KEEPTTL']]);
    expect(planEdit({ kind: 'setString', key: 'k', value: 'v', ttl: 30, keepTtl: false }).commands).toEqual([['SET', 'k', 'v', 'EX', '30']]);
  });

  it('renames a field only when the new name is free and the value is still the one loaded', () => {
    const p = planEdit({ kind: 'hashRenameField', key: 'h', from: 'a', to: 'b', value: '1' });
    expect(p).toEqual({
      watch: ['h'],
      checks: [
        { command: ['HEXISTS', 'h', 'b'], expect: 0, message: 'The hash already has a field “b”.' },
        { command: ['HGET', 'h', 'a'], expect: '1', message: 'The field “a” changed since it was loaded, so nothing was written.', stale: true },
      ],
      commands: [['HDEL', 'h', 'a'], ['HSET', 'h', 'b', '1']],
    });
    expect(planEdit({ kind: 'zsetRename', key: 'z', from: 'm', to: 'n', score: '2' }).checks[1]).toMatchObject({ command: ['ZSCORE', 'z', 'm'], expect: '2', stale: true });
  });

  it('deletes list elements by position, checking they are unchanged', () => {
    const p = planEdit({ kind: 'listDelete', key: 'l', items: [{ index: 0, expected: 'x' }, { index: 2, expected: { hex: 'ff' } }] }, 'DEL');
    expect(p.commands).toEqual([['LSET', 'l', '0', 'DEL'], ['LSET', 'l', '2', 'DEL'], ['LREM', 'l', '0', 'DEL']]);
    expect(p.checks.map((c) => [c.command, c.expect])).toEqual([[['LINDEX', 'l', '0'], 'x'], [['LINDEX', 'l', '2'], { hex: 'ff' }]]);
    expect(p.checks.every((c) => c.stale && c.message === LIST_CHANGED)).toBe(true);
  });

  it('creates keys of each type only when the name is free, with an optional TTL', () => {
    const p = planEdit({ kind: 'createKey', key: 'z', type: 'zset', ttl: 60, first: 'm', second: '1.5' });
    expect(p.commands).toEqual([['ZADD', 'z', '1.5', 'm'], ['EXPIRE', 'z', '60']]);
    expect(p.checks[0]?.command).toEqual(['EXISTS', 'z']);
    expect(planEdit({ kind: 'createKey', key: 's', type: 'stream', ttl: null, first: 'f', second: 'v' }).commands).toEqual([['XADD', 's', '*', 'f', 'v']]);
  });

  it('expires, persists and sets field TTLs', () => {
    expect(planEdit({ kind: 'expire', key: 'k', ttl: null }).commands).toEqual([['PERSIST', 'k']]);
    expect(planEdit({ kind: 'hashFieldTtl', key: 'h', field: 'f', ttl: 90 }).commands).toEqual([['HEXPIRE', 'h', '90', 'FIELDS', '1', 'f']]);
  });

  it('finds what makes an edit invalid', () => {
    expect(editProblem({ kind: 'zsetAdd', key: 'z', member: 'm', score: 'abc' })).toMatch(/score/);
    expect(editProblem({ kind: 'zsetAdd', key: 'z', member: 'm', score: '-inf' })).toBeNull();
    expect(editProblem({ kind: 'expire', key: 'k', ttl: 0 })).toMatch(/TTL/);
    expect(editProblem({ kind: 'createKey', key: '', type: 'string', ttl: null, first: '', second: '' })).toMatch(/key name/);
  });
});

describe('formatting', () => {
  it('formats commands for the log', () => {
    expect(formatCommand(['HSET', 'session:1', 'name', 'Daniel A.', { hex: '00ff' }])).toBe('HSET session:1 name "Daniel A." "\\x00\\xff"');
    expect(redisTextLabel({ hex: '6869' })).toBe('\\x68\\x69');
  });

  it('formats replies like redis-cli', () => {
    const reply: RedisReply = {
      kind: 'array',
      items: [
        { kind: 'bulk', value: 'a "b"\n' },
        { kind: 'integer', value: 3 },
        { kind: 'array', items: [{ kind: 'nil' }, { kind: 'status', text: 'OK' }] },
        ...Array.from({ length: 7 }, (_, i): RedisReply => ({ kind: 'bulk', value: String(i) })),
      ],
    };
    expect(formatReply(reply).split('\n').slice(0, 5)).toEqual([' 1) "a \\"b\\"\\n"', ' 2) (integer) 3', ' 3) 1) (nil)', '    2) OK', ' 4) "0"']);
    expect(formatReply({ kind: 'array', items: [] })).toBe('(empty array)');
    expect(formatReply({ kind: 'error', message: 'ERR unknown command' })).toBe('(error) ERR unknown command');
    expect(describeReply(reply)).toBe('10 items');
  });
});

describe('the key list command', () => {
  const parse = (line: string) => parseScanCommand(splitCommandLine(line));

  it('reads SCAN with its options in any case and order', () => {
    expect(parse('scan 1872 type HASH match "user:* x" count 100')).toEqual({
      ok: true,
      scan: { cursor: '1872', match: 'user:* x', count: 100, type: 'hash' },
      fromKeys: false,
    });
    expect(parse('SCAN 0')).toEqual({ ok: true, scan: { cursor: '0', match: '*', count: null, type: null }, fromKeys: false });
  });

  it('turns KEYS into a SCAN and leaves other commands alone', () => {
    expect(parse('KEYS session:*')).toEqual({ ok: true, scan: { cursor: '0', match: 'session:*', count: null, type: null }, fromKeys: true });
    expect(parse('KEYS')).toEqual({ ok: true, scan: { cursor: '0', match: '*', count: null, type: null }, fromKeys: true });
    expect(parse('HGETALL session:1')).toBeNull();
    expect(parse('PING')).toBeNull();
  });

  it('reads a lone pattern as a SCAN and starts a SCAN without a cursor at 0', () => {
    expect(parse('user:*')).toEqual({ ok: true, scan: { cursor: '0', match: 'user:*', count: null, type: null }, fromKeys: false });
    expect(parse('session:1')).toEqual({ ok: true, scan: { cursor: '0', match: 'session:1', count: null, type: null }, fromKeys: false });
    expect(parse('SCAN')).toEqual({ ok: true, scan: { cursor: '0', match: '*', count: null, type: null }, fromKeys: false });
    expect(parse('scan match user:* type hash')).toEqual({ ok: true, scan: { cursor: '0', match: 'user:*', count: null, type: 'hash' }, fromKeys: false });
  });

  it('explains what is wrong', () => {
    expect(parse('KEYS a b')).toEqual({ ok: false, error: 'KEYS takes one pattern; put a pattern with spaces in quotes, e.g. KEYS "user name:*".' });
    expect(parse('SCAN 0 COUNT many')).toEqual({ ok: false, error: 'COUNT must be a whole number above 0.' });
    expect(parse('SCAN 0 LIMIT 5')).toEqual({ ok: false, error: 'Unknown SCAN option “LIMIT”. Use MATCH, COUNT or TYPE.' });
    expect(parse('SCAN 0 MATCH')).toEqual({ ok: false, error: 'MATCH needs a value.' });
  });

  it('writes SCAN back so it reads the same', () => {
    const scan = { cursor: '0', match: 'a b', count: 500, type: 'zset' };
    expect(formatScanCommand(scan)).toBe('SCAN 0 MATCH "a b" COUNT 500 TYPE zset');
    expect(parse(formatScanCommand(scan))).toEqual({ ok: true, scan, fromKeys: false });
    expect(formatScanCommand({ cursor: '0', match: '*', count: null, type: null })).toBe('SCAN 0 MATCH *');
  });
});
