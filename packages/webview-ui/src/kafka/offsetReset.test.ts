import type { KafkaGroupOffset } from '@datakit/core';
import { describe, expect, it } from 'vitest';
import { formatTime } from './format';
import { describeReset, partitionList } from './offsetReset';

const row = (topic: string, partition: number, committed: number | null, start: number, end: number): KafkaGroupOffset => ({
  topic,
  partition,
  committed: committed === null ? null : String(committed),
  start: String(start),
  end: String(end),
  lag: committed === null ? null : end - committed,
});

describe('partitionList', () => {
  it('names one partition, pairs and runs', () => {
    expect(partitionList([3])).toBe('partition 3');
    expect(partitionList([1, 0])).toBe('partitions 0, 1');
    expect(partitionList([0, 1, 2, 5, 7, 8, 9])).toBe('partitions 0–2, 5, 7–9');
  });
});

describe('describeReset', () => {
  const rows = [row('orders', 0, 1_500, 1_000, 2_000), row('orders', 1, 2_000, 0, 2_000), row('payments', 3, 10, 0, 40)];

  it('counts the messages read again for earliest', () => {
    const s = describeReset(rows, { kind: 'earliest' });
    expect(s).toMatchObject({ to: 'the earliest offset', value: null, clamped: false });
    expect(s.topics).toEqual([
      { topic: 'orders', partitions: 'partitions 0, 1' },
      { topic: 'payments', partitions: 'partition 3' },
    ]);
    expect(s.effect).toBe('Consumers in this group will read 2,510 messages again.');
  });

  it('counts the messages skipped for latest', () => {
    expect(describeReset(rows, { kind: 'latest' }).effect).toBe('Consumers in this group will skip 530 messages they have not read yet.');
    expect(describeReset([row('orders', 0, 1_999, 0, 2_000)], { kind: 'latest' }).effect).toBe('Consumers in this group will skip 1 message they have not read yet.');
  });

  it('counts both ways for an offset and says when it is clamped', () => {
    const s = describeReset(rows, { kind: 'offset', offset: '1800' });
    expect(s).toMatchObject({ to: 'offset', value: '1,800', clamped: true });
    expect(s.effect).toBe('Consumers in this group will read 200 messages again and skip 330 they have not read yet.');
    expect(describeReset([row('orders', 0, 1_500, 1_000, 2_000)], { kind: 'offset', offset: '1500' })).toMatchObject({
      clamped: false,
      effect: 'The offsets are already there, so no message is read again or skipped.',
    });
  });

  it('counts a committed offset outside the partition from its nearest end', () => {
    expect(describeReset([row('orders', 0, 400, 1_000, 2_000)], { kind: 'earliest' }).effect).toBe('The offsets are already there, so no message is read again or skipped.');
  });

  it('gives no count for a time, which only the server can turn into offsets', () => {
    const time = new Date(2026, 9, 27, 14, 5).getTime();
    const s = describeReset(rows, { kind: 'timestamp', time });
    expect(s).toMatchObject({ to: 'the first message at or after', value: formatTime(time), clamped: false });
    expect(s.effect).toBe('Consumers in this group will continue from that time, reading again or skipping the messages between it and where they are now.');
  });

  it('lists a few topics and counts the rest', () => {
    const many = Array.from({ length: 11 }, (_, i) => row(`t${i}`, 0, 0, 0, 1));
    const s = describeReset(many, { kind: 'latest' });
    expect(s.topics).toHaveLength(8);
    expect(s.more).toBe(3);
    expect(s.effect).toBe('Consumers in this group will skip 11 messages they have not read yet.');
  });
});
