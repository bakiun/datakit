import { planEdit, RedisCheckError } from '@datakit/core';
import { WatchError } from 'redis';
import { describe, expect, it } from 'vitest';
import { RedisClientSession, type RawClient } from '../src/session';

/** A client whose EXEC loses the WATCH race `aborts` times; LINDEX answers `element`. */
function fakeClient(aborts: number, element = 'a') {
  const sent: string[] = [];
  let execs = 0;
  const client: RawClient = {
    sendCommand: async <T,>(args: readonly (string | Buffer)[]) => {
      sent.push(args.map(String).join(' '));
      return Buffer.from(element) as T;
    },
    multi: () => ({
      addCommand: (args) => sent.push(`queued ${args.map(String).join(' ')}`),
      exec: async () => {
        execs++;
        if (execs <= aborts) throw new WatchError();
        return ['OK'];
      },
      execAsPipeline: async () => [],
    }),
    watch: async () => sent.push('WATCH'),
    unwatch: async () => sent.push('UNWATCH'),
    select: async () => undefined,
    close: async () => undefined,
    destroy: () => undefined,
    on: () => undefined,
  };
  return { session: new RedisClientSession(client, undefined, { product: 'Redis', version: '8.0.0' }, 0), sent, execs: () => execs };
}

const listSet = planEdit({ kind: 'listSet', key: 'queue', index: 0, value: 'z', expected: 'a' });

describe('guarded writes', () => {
  it('run again, checks included, when the watched key changed before EXEC', async () => {
    const { session, sent, execs } = fakeClient(1);
    await session.write(listSet);
    expect(execs()).toBe(2);
    expect(sent.filter((line) => line === 'LINDEX queue 0')).toHaveLength(2);
  });

  it('give up after a few tries with a message that says nothing was written', async () => {
    const { session, execs } = fakeClient(10);
    await expect(session.write(listSet)).rejects.toThrow('The key kept changing while it was being written, so nothing was written. Try again.');
    expect(execs()).toBe(3);
  });

  it('do not retry a failed check: the item changed since it was loaded', async () => {
    const { session, execs } = fakeClient(0, 'b');
    const error = await session.write(listSet).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedisCheckError);
    expect((error as RedisCheckError).check.stale).toBe(true);
    expect(execs()).toBe(0);
  });
});
