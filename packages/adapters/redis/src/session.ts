import type { SshTunnel } from '@datakit/adapter-common';
import {
  sameRedisText,
  supportsFieldTtl,
  type HashRow,
  type RedisDatabase,
  type RedisKeyDetail,
  type RedisKeyInfo,
  type RedisPageStart,
  type RedisReply,
  type RedisScanOptions,
  type RedisSession,
  type RedisText,
  type RedisValuePage,
  type RedisWritePlan,
  type ServerVersion,
} from '@datakit/core';
import { WatchError } from 'redis';
import { asString, comparable, toArg, toRedisText, toReply } from './values';

type Arg = string | Buffer;

/** What the session uses of a node-redis client whose bulk strings come back as Buffers. */
export interface RawClient {
  sendCommand<T = unknown>(args: readonly Arg[]): Promise<T>;
  multi(): { addCommand(args: readonly Arg[]): unknown; exec(): Promise<unknown[]>; execAsPipeline(): Promise<unknown[]> };
  watch(keys: Arg[]): Promise<unknown>;
  unwatch(): Promise<unknown>;
  select(database: number): Promise<unknown>;
  close(): Promise<void>;
  destroy(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

/** SCAN rounds stop after this long even if fewer keys than wanted were found, so a sparse MATCH does not hang the view. */
const SCAN_BUDGET_MS = 1500;
const LENGTH_COMMANDS: Record<string, string> = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };
/** Commands the CLI does not pass on: they would change the connection under the key browser. */
const CLI_REFUSED = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH', 'QUIT', 'RESET', 'HELLO']);

const ttlOf = (pttl: unknown): number | null => (typeof pttl === 'number' && pttl >= 0 ? Math.ceil(pttl / 1000) : null);
const isAtLeast = (version: string, major: number, minor = 0) => {
  const [a = 0, b = 0] = version.split('.').map(Number);
  return a > major || (a === major && b >= minor);
};

export class RedisClientSession implements RedisSession {
  readonly kind = 'redis';
  private ended = false;
  private lastError: Error | undefined;
  private readonly listeners: ((error?: Error) => void)[] = [];

  constructor(
    private readonly client: RawClient,
    private readonly tunnel: SshTunnel | undefined,
    readonly serverVersion: ServerVersion,
    private selected: number,
  ) {
    client.on('error', (error) => (this.lastError = error));
    client.on('end', () => this.end(this.lastError));
    tunnel?.onDidClose((error) => this.end(error ?? new Error('The SSH tunnel was closed.')));
  }

  get database(): number {
    return this.selected;
  }

  get fieldTtl(): boolean {
    return supportsFieldTtl(this.serverVersion);
  }

  private run<T = unknown>(args: readonly Arg[]): Promise<T> {
    return this.client.sendCommand<T>(args);
  }

  private async pipeline(commands: Arg[][]): Promise<unknown[]> {
    if (!commands.length) return [];
    const multi = this.client.multi();
    for (const command of commands) multi.addCommand(command);
    return multi.execAsPipeline();
  }

  async usedMemory(): Promise<string | null> {
    const info = asString(await this.run(['INFO', 'memory']));
    return /^used_memory_human:(.+)$/m.exec(info)?.[1]?.trim() ?? null;
  }

  async databases(): Promise<RedisDatabase[]> {
    let count = 16;
    try {
      const reply = await this.run<unknown[]>(['CONFIG', 'GET', 'databases']);
      if (Array.isArray(reply) && reply[1] !== undefined) count = Number(asString(reply[1])) || count;
    } catch {
      // Managed servers often refuse CONFIG; 16 is the default.
    }
    const keys = new Map<number, number>();
    for (const match of asString(await this.run(['INFO', 'keyspace'])).matchAll(/^db(\d+):keys=(\d+)/gm)) {
      keys.set(Number(match[1]), Number(match[2]));
    }
    count = Math.max(count, ...[...keys.keys()].map((i) => i + 1));
    return Array.from({ length: count }, (_, index) => ({ index, keys: keys.get(index) ?? 0 }));
  }

  async select(database: number): Promise<void> {
    await this.client.select(database);
    this.selected = database;
  }

  async dbSize(): Promise<number> {
    return Number(await this.run(['DBSIZE']));
  }

  async scan(cursor: string, options: RedisScanOptions): Promise<{ keys: RedisKeyInfo[]; cursor: string }> {
    // SCAN TYPE exists from Redis 6; older servers are filtered here.
    const serverType = options.type && isAtLeast(this.serverVersion.version, 6);
    const found: Buffer[] = [];
    const started = performance.now();
    let next = cursor;
    do {
      const args: Arg[] = ['SCAN', next, 'MATCH', options.match || '*', 'COUNT', String(options.count)];
      if (serverType) args.push('TYPE', options.type!);
      const [nextCursor, keys] = await this.run<[Buffer, Buffer[]]>(args);
      next = asString(nextCursor);
      found.push(...keys);
    } while (next !== '0' && found.length < options.want && performance.now() - started < SCAN_BUDGET_MS);

    const replies = await this.pipeline(found.flatMap((key) => [['TYPE', key], ['PTTL', key]]));
    const keys: RedisKeyInfo[] = [];
    found.forEach((key, i) => {
      const type = asString(replies[i * 2]);
      // A key can expire between SCAN and TYPE.
      if (type === 'none' || (options.type && type !== options.type)) return;
      keys.push({ key: toRedisText(key), type, ttl: ttlOf(replies[i * 2 + 1]) });
    });
    return { keys, cursor: next };
  }

  async describeKey(key: RedisText): Promise<RedisKeyDetail | null> {
    const k = toArg(key);
    const type = asString(await this.run(['TYPE', k]));
    if (type === 'none') return null;
    const lengthCommand = LENGTH_COMMANDS[type];
    const [pttl, length, encoding] = await this.pipeline([['PTTL', k], lengthCommand ? [lengthCommand, k] : ['EXISTS', k], ['OBJECT', 'ENCODING', k]]);
    let size: number | null = null;
    try {
      size = Number(await this.run(['MEMORY', 'USAGE', k]));
    } catch {
      // MEMORY USAGE may be disabled by ACL or not exist on old servers.
    }
    return {
      key,
      type,
      ttl: ttlOf(pttl),
      length: lengthCommand ? Number(length) : null,
      size,
      encoding: encoding === null || encoding === undefined ? null : asString(encoding),
    };
  }

  async readValue(key: RedisText, type: string, start: RedisPageStart, count: number, maxBytes: number): Promise<RedisValuePage> {
    const k = toArg(key);
    switch (type) {
      case 'string': {
        const length = Number(await this.run(['STRLEN', k]));
        const bytes = await this.run<Buffer>(['GETRANGE', k, '0', String(maxBytes - 1)]);
        const truncated = length > maxBytes;
        return { type, value: toRedisText(bytes, truncated), length, truncated };
      }
      case 'hash': {
        const { items, next } = await this.scanItems('HSCAN', k, start, count, 2);
        const fields = items.filter((_, i) => i % 2 === 0);
        let ttls: unknown[] = [];
        if (this.fieldTtl && fields.length) ttls = await this.run<unknown[]>(['HTTL', k, 'FIELDS', String(fields.length), ...fields]);
        const rows: HashRow[] = fields.map((field, i) => ({
          field: toRedisText(field),
          value: toRedisText(items[i * 2 + 1]!),
          ttl: typeof ttls[i] === 'number' && (ttls[i] as number) >= 0 ? (ttls[i] as number) : null,
        }));
        return { type, rows, next };
      }
      case 'set': {
        const { items, next } = await this.scanItems('SSCAN', k, start, count, 1);
        return { type, rows: items.map((member) => ({ member: toRedisText(member) })), next };
      }
      case 'list': {
        const from = typeof start === 'number' ? start : 0;
        const items = await this.run<Buffer[]>(['LRANGE', k, String(from), String(from + count - 1)]);
        return { type, rows: items.map((value, i) => ({ index: from + i, value: toRedisText(value) })), next: items.length === count ? from + count : null };
      }
      case 'zset': {
        const from = typeof start === 'number' ? start : 0;
        const items = await this.run<Buffer[]>(['ZRANGE', k, String(from), String(from + count - 1), 'WITHSCORES']);
        const rows = [];
        for (let i = 0; i < items.length; i += 2) rows.push({ member: toRedisText(items[i]!), score: asString(items[i + 1]) });
        return { type, rows, next: rows.length === count ? from + count : null };
      }
      case 'stream': {
        const from = typeof start === 'string' ? `(${start}` : '-';
        const entries = await this.run<[Buffer, Buffer[]][]>(['XRANGE', k, from, '+', 'COUNT', String(count)]);
        const rows = entries.map(([id, values]) => {
          const fields: [RedisText, RedisText][] = [];
          for (let i = 0; i < values.length; i += 2) fields.push([toRedisText(values[i]!), toRedisText(values[i + 1]!)]);
          return { id: asString(id), fields };
        });
        return { type, rows, next: rows.length === count ? rows.at(-1)!.id : null };
      }
      default:
        return { type: 'other', message: `Keys of type ${type} are listed but not shown here; read them in the CLI below.` };
    }
  }

  /** HSCAN or SSCAN from a cursor until about `count` items are read; returns the flat reply and the next cursor. */
  private async scanItems(command: 'HSCAN' | 'SSCAN', key: Arg, start: RedisPageStart, count: number, width: number) {
    const items: Buffer[] = [];
    let cursor = typeof start === 'string' ? start : '0';
    const started = performance.now();
    do {
      const [next, batch] = await this.run<[Buffer, Buffer[]]>([command, key, cursor, 'COUNT', String(count)]);
      cursor = asString(next);
      items.push(...batch);
    } while (cursor !== '0' && items.length / width < count && performance.now() - started < SCAN_BUDGET_MS);
    return { items, next: cursor === '0' ? null : cursor };
  }

  async write(plan: RedisWritePlan): Promise<void> {
    const commands = plan.commands.map((c) => c.map(toArg));
    if (!plan.watch.length && !plan.checks.length && commands.length === 1) {
      await this.run(commands[0]!);
      return;
    }
    if (plan.watch.length) await this.client.watch(plan.watch.map(toArg));
    try {
      for (const check of plan.checks) {
        const reply = comparable(await this.run(check.command.map(toArg)));
        const same = typeof reply === 'object' && reply !== null && typeof check.expect === 'object' && check.expect !== null ? sameRedisText(reply, check.expect) : reply === check.expect;
        if (!same) throw new Error(check.message);
      }
    } catch (error) {
      await this.client.unwatch();
      throw error;
    }
    const multi = this.client.multi();
    for (const command of commands) multi.addCommand(command);
    try {
      await multi.exec();
    } catch (error) {
      if (error instanceof WatchError) throw new Error('The key changed while it was being written; reload it and try again.');
      throw error;
    }
  }

  async command(args: string[]): Promise<RedisReply> {
    const name = args[0]?.toUpperCase() ?? '';
    if (CLI_REFUSED.has(name)) return { kind: 'error', message: `${name} cannot be used in this console.` };
    try {
      if (name === 'SELECT' && args.length === 2 && /^\d+$/.test(args[1]!)) {
        await this.select(Number(args[1]));
        return { kind: 'status', text: 'OK' };
      }
      return toReply(await this.run(args));
    } catch (error) {
      return { kind: 'error', message: (error as Error).message };
    }
  }

  async commandFlags(name: string): Promise<string[] | null> {
    const [info] = await this.run<unknown[][]>(['COMMAND', 'INFO', name.toLowerCase()]);
    return Array.isArray(info) && Array.isArray(info[2]) ? (info[2] as unknown[]).map(asString) : null;
  }

  async close(): Promise<void> {
    if (this.ended) return;
    try {
      await this.client.close();
    } catch {
      this.client.destroy();
    }
    this.end();
  }

  onDidClose(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }

  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.tunnel?.close();
    for (const listener of this.listeners) listener(error);
  }
}
