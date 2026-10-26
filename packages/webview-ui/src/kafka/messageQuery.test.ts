import { describe, expect, it } from 'vitest';
import { buildMessageQuery, type MessageFilter } from './messageQuery';

const filter = (id: number, type: MessageFilter['type'], from: string, to = ''): MessageFilter => ({ id, type, from, to });

describe('buildMessageQuery', () => {
  it('reads every kind of filter', () => {
    const built = buildMessageQuery('orders', 100, 6, [
      filter(1, 'text', '  alice '),
      filter(2, 'partition', '3'),
      filter(3, 'offset', '1,000', '2000'),
      filter(4, 'date', '2026-10-24 10:00', '2026-10-24 11:00'),
    ]);
    expect(built.problems.size).toBe(0);
    expect(built.active).toBe(4);
    expect(built.query).toEqual({
      topic: 'orders',
      limit: 100,
      partition: 3,
      fromOffset: '1000',
      toOffset: '2000',
      fromTime: new Date(2026, 9, 24, 10, 0).getTime(),
      toTime: new Date(2026, 9, 24, 11, 0, 59, 999).getTime(),
      text: 'alice',
    });
  });

  it('leaves out empty filters without calling them a problem', () => {
    const built = buildMessageQuery('orders', 500, 6, [filter(1, 'text', ''), filter(2, 'offset', '', ''), filter(3, 'date', '', '')]);
    expect(built.active).toBe(0);
    expect(built.problems.size).toBe(0);
    expect(built.query.text).toBeNull();
  });

  it('names filters that cannot be read and leaves them out', () => {
    const built = buildMessageQuery('orders', 100, 6, [filter(1, 'partition', '9'), filter(2, 'offset', '50', '10'), filter(3, 'date', 'noon')]);
    expect(built.active).toBe(0);
    expect(built.problems.get(1)).toBe('Partitions are 0 to 5.');
    expect(built.problems.get(2)).toBe('The range starts after it ends.');
    expect(built.problems.get(3)).toBe('Times are YYYY-MM-DD HH:MM[:SS].');
    expect(built.query.partition).toBeNull();
    expect(built.query.fromOffset).toBeNull();
  });

  it('takes an open-ended range', () => {
    const built = buildMessageQuery('orders', 100, 6, [filter(1, 'offset', '', '42')]);
    expect(built.query.fromOffset).toBeNull();
    expect(built.query.toOffset).toBe('42');
    expect(built.active).toBe(1);
  });
});
