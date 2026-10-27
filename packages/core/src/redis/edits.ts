import type { RedisArg, RedisCheck, RedisCommand, RedisKeyType, RedisText, RedisWritePlan } from './types';
import { redisTextLabel } from './types';

/** A change the key browser makes. Each becomes a write plan: commands in MULTI/EXEC, guarded by checks. */
export type RedisEdit =
  | { kind: 'setString'; key: RedisText; value: string; ttl: number | null; keepTtl: boolean }
  | { kind: 'hashSet'; key: RedisText; field: RedisText; value: string }
  | { kind: 'hashRenameField'; key: RedisText; from: RedisText; to: string; value: RedisText }
  | { kind: 'hashFieldTtl'; key: RedisText; field: RedisText; ttl: number | null }
  | { kind: 'hashDelete'; key: RedisText; fields: RedisText[] }
  | { kind: 'listSet'; key: RedisText; index: number; value: string; expected: RedisText }
  | { kind: 'listPush'; key: RedisText; value: string }
  | { kind: 'listDelete'; key: RedisText; items: { index: number; expected: RedisText }[] }
  | { kind: 'setAdd'; key: RedisText; member: string }
  | { kind: 'setRename'; key: RedisText; from: RedisText; to: string }
  | { kind: 'setDelete'; key: RedisText; members: RedisText[] }
  | { kind: 'zsetAdd'; key: RedisText; member: RedisText; score: string }
  | { kind: 'zsetRename'; key: RedisText; from: RedisText; to: string; score: string }
  | { kind: 'zsetDelete'; key: RedisText; members: RedisText[] }
  | { kind: 'streamAdd'; key: RedisText; fields: [string, string][] }
  | { kind: 'streamDelete'; key: RedisText; ids: string[] }
  | { kind: 'renameKey'; key: RedisText; to: string }
  | { kind: 'expire'; key: RedisText; ttl: number | null }
  | { kind: 'deleteKeys'; keys: RedisText[] }
  | { kind: 'createKey'; key: string; type: RedisKeyType; ttl: number | null; first: string; second: string };

const SCORE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^[+-]?inf$/i;

export function isValidScore(score: string): boolean {
  return SCORE.test(score.trim());
}

/** What is wrong with an edit before it is sent, e.g. an empty field name; null when it can be sent. */
export function editProblem(edit: RedisEdit): string | null {
  const ttlOk = (ttl: number | null) => ttl === null || (Number.isInteger(ttl) && ttl > 0);
  switch (edit.kind) {
    case 'hashRenameField':
      return edit.to === '' ? 'The field name cannot be empty.' : null;
    case 'setRename':
    case 'zsetRename':
      return edit.to === '' ? 'The member cannot be empty.' : null;
    case 'zsetAdd':
      return isValidScore(edit.score) ? null : 'The score must be a number, inf or -inf.';
    case 'renameKey':
      return edit.to === '' ? 'The key name cannot be empty.' : null;
    case 'createKey':
      if (edit.key === '') return 'The key name cannot be empty.';
      if (edit.type === 'zset' && !isValidScore(edit.second)) return 'The score must be a number, inf or -inf.';
      if ((edit.type === 'hash' || edit.type === 'stream') && edit.first === '') return 'The field name cannot be empty.';
      return ttlOk(edit.ttl) ? null : 'TTL must be a whole number of seconds above 0.';
    case 'expire':
    case 'hashFieldTtl':
      return ttlOk(edit.ttl) ? null : 'TTL must be a whole number of seconds above 0.';
    case 'streamAdd':
      return edit.fields.some(([f]) => f === '') ? 'The field name cannot be empty.' : null;
    default:
      return null;
  }
}

const plan = (commands: RedisCommand[], watch: RedisArg[] = [], checks: RedisWritePlan['checks'] = []): RedisWritePlan => ({ watch, checks, commands });

/** The message of the checks that find a list element changed since it was loaded. */
export const LIST_CHANGED = 'The list changed since it was loaded, so nothing was written.';

/** Checks that an item still holds what was loaded, so a change made meanwhile is not overwritten. */
const unchanged = (command: RedisCommand, expect: RedisText | null, message: string): RedisCheck => ({ command, expect, message, stale: true });

/**
 * The commands of an edit. Renames check that the new name is free and that the item still holds what they carry
 * over, list edits that the element is still the one shown, so a change made meanwhile is not overwritten.
 * `sentinel` marks list elements to delete: Redis deletes list elements by value, not by position.
 */
export function planEdit(edit: RedisEdit, sentinel = `datakit:deleted:${Math.random().toString(36).slice(2)}`): RedisWritePlan {
  const k: RedisArg = 'key' in edit ? edit.key : '';
  switch (edit.kind) {
    case 'setString':
      // Without KEEPTTL (Redis < 6) the TTL is set again from what was shown.
      if (edit.keepTtl) return plan([['SET', k, edit.value, 'KEEPTTL']]);
      return plan(edit.ttl === null ? [['SET', k, edit.value]] : [['SET', k, edit.value, 'EX', String(edit.ttl)]]);
    case 'hashSet':
      return plan([['HSET', k, edit.field, edit.value]]);
    case 'hashRenameField':
      return plan(
        [['HDEL', k, edit.from], ['HSET', k, edit.to, edit.value]],
        [k],
        [
          { command: ['HEXISTS', k, edit.to], expect: 0, message: `The hash already has a field “${edit.to}”.` },
          unchanged(['HGET', k, edit.from], edit.value, `The field “${redisTextLabel(edit.from)}” changed since it was loaded, so nothing was written.`),
        ],
      );
    case 'hashFieldTtl':
      return plan([edit.ttl === null ? ['HPERSIST', k, 'FIELDS', '1', edit.field] : ['HEXPIRE', k, String(edit.ttl), 'FIELDS', '1', edit.field]]);
    case 'hashDelete':
      return plan([['HDEL', k, ...edit.fields]]);
    case 'listSet':
      return plan([['LSET', k, String(edit.index), edit.value]], [k], [unchanged(['LINDEX', k, String(edit.index)], edit.expected, LIST_CHANGED)]);
    case 'listPush':
      return plan([['RPUSH', k, edit.value]]);
    case 'listDelete':
      return plan(
        [...edit.items.map((item): RedisCommand => ['LSET', k, String(item.index), sentinel]), ['LREM', k, '0', sentinel]],
        [k],
        edit.items.map((item) => unchanged(['LINDEX', k, String(item.index)], item.expected, LIST_CHANGED)),
      );
    case 'setAdd':
      return plan([['SADD', k, edit.member]]);
    case 'setRename':
      return plan(
        [['SREM', k, edit.from], ['SADD', k, edit.to]],
        [k],
        [{ command: ['SISMEMBER', k, edit.to], expect: 0, message: `The set already has “${edit.to}”.` }],
      );
    case 'setDelete':
      return plan([['SREM', k, ...edit.members]]);
    case 'zsetAdd':
      return plan([['ZADD', k, edit.score.trim(), edit.member]]);
    case 'zsetRename':
      return plan(
        [['ZREM', k, edit.from], ['ZADD', k, edit.score, edit.to]],
        [k],
        [
          { command: ['ZSCORE', k, edit.to], expect: null, message: `The sorted set already has “${edit.to}”.` },
          unchanged(['ZSCORE', k, edit.from], edit.score, `The score of “${redisTextLabel(edit.from)}” changed since it was loaded, so nothing was written.`),
        ],
      );
    case 'zsetDelete':
      return plan([['ZREM', k, ...edit.members]]);
    case 'streamAdd':
      return plan([['XADD', k, '*', ...edit.fields.flat()]]);
    case 'streamDelete':
      return plan([['XDEL', k, ...edit.ids]]);
    case 'renameKey':
      return plan([['RENAME', k, edit.to]], [k, edit.to], [{ command: ['EXISTS', edit.to], expect: 0, message: `A key named “${edit.to}” already exists.` }]);
    case 'expire':
      return plan([edit.ttl === null ? ['PERSIST', k] : ['EXPIRE', k, String(edit.ttl)]]);
    case 'deleteKeys':
      return plan([['UNLINK', ...edit.keys]]);
    case 'createKey': {
      const create: Record<RedisKeyType, RedisCommand> = {
        string: ['SET', k, edit.first],
        hash: ['HSET', k, edit.first, edit.second],
        list: ['RPUSH', k, edit.first],
        set: ['SADD', k, edit.first],
        zset: ['ZADD', k, edit.second.trim(), edit.first],
        stream: ['XADD', k, '*', edit.first, edit.second],
      };
      const commands = [create[edit.type]];
      if (edit.ttl !== null) commands.push(['EXPIRE', k, String(edit.ttl)]);
      return plan(commands, [k], [{ command: ['EXISTS', k], expect: 0, message: `A key named “${edit.key}” already exists.` }]);
    }
  }
}

/** An argument as redis-cli takes it: quoted when it has spaces or quotes. */
function quoteArg(arg: RedisArg): string {
  if (typeof arg !== 'string') return `"${redisTextLabel(arg)}"`;
  return arg === '' || /[\s"'\\]/.test(arg) ? JSON.stringify(arg) : arg;
}

/** A command as one line for the CLI log, with long arguments shortened. */
export function formatCommand(command: RedisCommand, maxArg = 60): string {
  return command
    .map((arg) => {
      const quoted = quoteArg(arg);
      return quoted.length > maxArg ? `${quoted.slice(0, maxArg)}…` : quoted;
    })
    .join(' ');
}

/** Edits that remove data ask first. */
export function removesData(edit: RedisEdit): boolean {
  return ['hashDelete', 'listDelete', 'setDelete', 'zsetDelete', 'streamDelete', 'deleteKeys'].includes(edit.kind);
}
