import type { KafkaMessage } from '@datakit/core';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatElapsed,
  formatTime,
  groupState,
  hexRows,
  messageJson,
  offsetText,
  parseLocalTime,
  parseOffset,
  parsePartition,
  payloadBytes,
  payloadPreview,
  prettyJson,
  stringMap,
  textTable,
  totalLag,
} from './format';

const text = (t: string) => ({ text: t, binary: false, size: t.length, truncated: false, schemaId: null, decoded: null });

describe('formatBytes', () => {
  it('uses one decimal below ten and whole numbers above', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(742 * 1024 ** 2)).toBe('742 MB');
    expect(formatBytes(1.1 * 1024 ** 3)).toBe('1.1 GB');
  });
});

describe('times', () => {
  it('formats local times and running times', () => {
    expect(formatTime(new Date(2026, 9, 24, 7, 5, 9).getTime())).toBe('2026-10-24 07:05:09');
    expect(formatElapsed(134_000)).toBe('02:14');
    expect(formatElapsed(3_734_000)).toBe('1:02:14');
  });

  it('reads local times; an end bound reaches to the end of what was left out', () => {
    expect(parseLocalTime('')).toEqual({ value: null, error: null });
    expect(parseLocalTime('2026-10-24 12:30').value).toBe(new Date(2026, 9, 24, 12, 30).getTime());
    expect(parseLocalTime('2026-10-24 12:30', true).value).toBe(new Date(2026, 9, 24, 12, 30, 59, 999).getTime());
    expect(parseLocalTime('2026-10-24 12:30:15').value).toBe(new Date(2026, 9, 24, 12, 30, 15).getTime());
    expect(parseLocalTime('2026-10-24', true).value).toBe(new Date(2026, 9, 24, 23, 59, 59, 999).getTime());
    expect(parseLocalTime('2026-02-30 10:00').error).not.toBeNull();
    expect(parseLocalTime('yesterday').error).not.toBeNull();
  });
});

describe('numbers typed in filters', () => {
  it('reads offsets as int64 strings', () => {
    expect(parseOffset(' 1,204,380 ')).toEqual({ value: '1204380', error: null });
    expect(parseOffset('9223372036854775807').value).toBe('9223372036854775807');
    expect(parseOffset('12a').error).not.toBeNull();
    expect(parseOffset('')).toEqual({ value: null, error: null });
    expect(offsetText('1204380')).toBe('1,204,380');
  });

  it('checks partitions against the topic', () => {
    expect(parsePartition('3', 6).value).toBe(3);
    expect(parsePartition('6', 6).error).toBe('Partitions are 0 to 5.');
    expect(parsePartition('-1', 6).error).not.toBeNull();
  });
});

describe('payloads', () => {
  it('previews null, empty, binary and decoded payloads', () => {
    expect(payloadPreview(null)).toEqual({ text: 'null', muted: true });
    expect(payloadPreview(text(''))).toEqual({ text: '(empty)', muted: true });
    expect(payloadPreview({ ...text('00ff'), binary: true })).toEqual({ text: '0x00ff', muted: true });
    expect(payloadPreview({ ...text('0000'), binary: true, decoded: '{\n  "a": 1\n}' })).toEqual({ text: '{"a":1}', muted: false });
  });

  it('pretty-prints JSON objects and arrays only', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('42')).toBeNull();
    expect(prettyJson('{oops')).toBeNull();
  });

  it('dumps bytes as hex rows with ASCII', () => {
    const rows = hexRows(payloadBytes(text('{"order_id":1137}')));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ offset: '0000', hex: '7b 22 6f 72 64 65 72 5f 69 64 22 3a 31 31 33 37', ascii: '{"order_id":1137' });
    expect(rows[1]!.offset).toBe('0010');
    expect(rows[1]!.hex.trimEnd()).toBe('7d');
    expect(hexRows(payloadBytes({ ...text('00ff41'), binary: true }))[0]!.ascii).toBe('..A');
    expect(hexRows(new Uint8Array(100), 32)).toHaveLength(2);
  });

  it('writes a message as one JSON line, decoded values as JSON', () => {
    const message: KafkaMessage = {
      partition: 2,
      offset: '17',
      timestamp: Date.UTC(2026, 9, 24, 9, 0, 0),
      key: text('k-1'),
      value: { ...text('00000000'), binary: true, schemaId: 7, decoded: '{"a":1}' },
      headers: [{ key: 'trace-id', value: 'abc' }],
    };
    expect(JSON.parse(messageJson(message))).toEqual({
      partition: 2,
      offset: '17',
      timestamp: '2026-10-24T09:00:00.000Z',
      key: 'k-1',
      value: { a: 1 },
      headers: [{ key: 'trace-id', value: 'abc' }],
    });
  });
});

describe('groups', () => {
  it('sums lag and keeps unknown lag apart', () => {
    expect(totalLag({ id: 'g', state: 'Stable', protocolType: 'consumer', members: 1, lagByTopic: { a: 3, b: null, c: 4 } })).toBe(7);
    expect(totalLag({ id: 'g', state: 'Stable', protocolType: 'consumer', members: 1, lagByTopic: { a: null } })).toBeNull();
  });

  it('labels rebalancing states alike', () => {
    expect(groupState('PreparingRebalance')).toEqual({ label: 'Rebalancing', tone: 'warn' });
    expect(groupState('Stable').tone).toBe('ok');
    expect(groupState('Dead').tone).toBe('error');
  });
});

describe('textTable', () => {
  it('pads columns and right-aligns numbers', () => {
    expect(textTable(['TOPIC', 'N'], [['a', '1'], ['bbb', '22']], [false, true])).toBe('TOPIC   N\n-----  --\na       1\nbbb    22');
  });
});

describe('stringMap', () => {
  it('accepts objects of strings only', () => {
    expect(stringMap('{"tasks.max":"1"}')).toEqual({ value: { 'tasks.max': '1' }, error: null });
    expect(stringMap('{"tasks.max":1}').error).toBe('“tasks.max” must be a string, e.g. "1".');
    expect(stringMap('[]').error).toBe('The config is a JSON object.');
    expect(stringMap('{').error).toBe('Not valid JSON.');
  });
});
