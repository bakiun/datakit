import type { ServerSession, ServerVersion } from '../sql/session';

/** Redis strings are bytes: text when they are valid UTF-8, hex otherwise, so binary keys and values survive a round trip. */
export type RedisText = string | { hex: string };

/** Key types the browser reads and edits; modules add others (e.g. `ReJSON-RL`), which are only listed. */
export const REDIS_KEY_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;
export type RedisKeyType = (typeof REDIS_KEY_TYPES)[number];

export function isRedisKeyType(type: string): type is RedisKeyType {
  return (REDIS_KEY_TYPES as readonly string[]).includes(type);
}

/** Text to show for a Redis string; binary ones as `\x..` escapes, like redis-cli. */
export function redisTextLabel(text: RedisText): string {
  if (typeof text === 'string') return text;
  return text.hex.replace(/../g, (byte) => `\\x${byte}`);
}

export function sameRedisText(a: RedisText, b: RedisText): boolean {
  return typeof a === 'string' && typeof b === 'string' ? a === b : typeof a !== 'string' && typeof b !== 'string' && a.hex === b.hex;
}

/** Per-field hash expiry (HEXPIRE, HTTL, HPERSIST) came with Redis 7.4. */
export function supportsFieldTtl(version: ServerVersion): boolean {
  const [major = 0, minor = 0] = version.version.split('.').map(Number);
  return version.product === 'Redis' && (major > 7 || (major === 7 && minor >= 4));
}

/** SET … KEEPTTL came with Redis 6.0. */
export function supportsKeepTtl(version: ServerVersion): boolean {
  return Number(version.version.split('.')[0]) >= 6;
}

export interface RedisKeyInfo {
  key: RedisText;
  /** The TYPE reply, e.g. `hash`, or a module type such as `ReJSON-RL`. */
  type: string;
  /** Seconds until the key expires; null when it does not expire. */
  ttl: number | null;
}

export interface RedisDatabase {
  index: number;
  keys: number;
}

export interface RedisKeyDetail extends RedisKeyInfo {
  /** Bytes of a string, items of the other types; null for types the browser does not read. */
  length: number | null;
  /** MEMORY USAGE in bytes; null when the server does not allow it. */
  size: number | null;
  /** OBJECT ENCODING, e.g. `listpack`. */
  encoding: string | null;
}

export interface HashRow {
  field: RedisText;
  value: RedisText;
  /** Seconds until the field expires (Redis 7.4+); null when it does not. */
  ttl: number | null;
}

export interface ListRow {
  index: number;
  value: RedisText;
}

export interface SetRow {
  member: RedisText;
}

export interface ZsetRow {
  member: RedisText;
  /** As Redis returns it, so `inf` and long fractions stay exact. */
  score: string;
}

export interface StreamRow {
  id: string;
  fields: [RedisText, RedisText][];
}

/**
 * A page of a key's value. Hashes and sets page with a SCAN cursor (`'0'` when done), lists and sorted sets by
 * position, streams by entry id; `next` is null on the last page.
 */
export type RedisValuePage =
  | { type: 'string'; value: RedisText; length: number; truncated: boolean }
  | { type: 'hash'; rows: HashRow[]; next: string | null }
  | { type: 'list'; rows: ListRow[]; next: number | null }
  | { type: 'set'; rows: SetRow[]; next: string | null }
  | { type: 'zset'; rows: ZsetRow[]; next: number | null }
  | { type: 'stream'; rows: StreamRow[]; next: string | null }
  | { type: 'other'; message: string };

/** Where the next page of a value starts, from the previous page's `next`. */
export type RedisPageStart = string | number | null;

/** An argument of a Redis command. */
export type RedisArg = RedisText;
export type RedisCommand = RedisArg[];

/** A command whose reply must equal `expect` before the write goes ahead, e.g. that a list element is unchanged. */
export interface RedisCheck {
  command: RedisCommand;
  expect: RedisText | number | null;
  /** Shown when the reply differs. */
  message: string;
}

/** Commands that run together in MULTI/EXEC, after WATCH on `watch` and the checks passed. */
export interface RedisWritePlan {
  watch: RedisArg[];
  checks: RedisCheck[];
  commands: RedisCommand[];
}

/** A reply as the CLI shows it. RESP2 types only: sessions speak RESP2, like redis-cli. */
export type RedisReply =
  | { kind: 'status'; text: string }
  | { kind: 'error'; message: string }
  | { kind: 'integer'; value: number }
  | { kind: 'bulk'; value: RedisText }
  | { kind: 'nil' }
  | { kind: 'array'; items: RedisReply[] };

export interface RedisScanOptions {
  /** SCAN MATCH pattern; `*` lists everything. */
  match: string;
  /** SCAN TYPE filter; null for all types. */
  type: string | null;
  /** The COUNT hint sent with each SCAN call. */
  count: number;
  /** Keys to collect before returning, unless the scan ends first. */
  want: number;
}

/** An open connection to a Redis server, implemented by the Redis adapter. */
export interface RedisSession extends ServerSession {
  readonly kind: 'redis';
  /** The selected database index. */
  readonly database: number;
  /** `used_memory_human` from INFO, e.g. `412.50M`. */
  usedMemory(): Promise<string | null>;
  /** Every database index with its number of keys. */
  databases(): Promise<RedisDatabase[]>;
  select(database: number): Promise<void>;
  dbSize(): Promise<number>;
  /** SCANs from `cursor` until `want` keys are found or the scan ends; `cursor` is `'0'` when it ended. */
  scan(cursor: string, options: RedisScanOptions): Promise<{ keys: RedisKeyInfo[]; cursor: string }>;
  /** Null when the key does not exist. */
  describeKey(key: RedisText): Promise<RedisKeyDetail | null>;
  /** A page of the value; strings are read up to `maxBytes`. */
  readValue(key: RedisText, type: string, start: RedisPageStart, count: number, maxBytes: number): Promise<RedisValuePage>;
  /** Runs a write plan; throws when a check fails or a watched key changed meanwhile. */
  write(plan: RedisWritePlan): Promise<void>;
  /** Runs one command as typed in the CLI; errors come back as `error` replies. */
  command(args: string[]): Promise<RedisReply>;
  /** The flags of a command from COMMAND INFO, e.g. `write`; null when the server does not know it. */
  commandFlags(name: string): Promise<string[] | null>;
}
