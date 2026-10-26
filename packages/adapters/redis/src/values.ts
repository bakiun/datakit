import type { RedisArg, RedisReply, RedisText } from '@datakit/core';
import { ErrorReply } from 'redis';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });

/** Bytes from Redis as text when they are valid UTF-8, as hex otherwise. */
export function toRedisText(value: Buffer, allowBroken = false): RedisText {
  try {
    return utf8.decode(value);
  } catch {
    // A string cut short for display may end in the middle of a character.
    return allowBroken ? lenient.decode(value) : { hex: value.toString('hex') };
  }
}

/** A command argument as node-redis sends it. */
export function toArg(arg: RedisArg): string | Buffer {
  return typeof arg === 'string' ? arg : Buffer.from(arg.hex, 'hex');
}

/** Text of a reply that should be a string, such as a TYPE or score reply. */
export function asString(reply: unknown): string {
  return Buffer.isBuffer(reply) ? reply.toString('utf8') : String(reply);
}

/** A raw RESP2 reply (bulk strings mapped to Buffers) in the shape the CLI shows. */
export function toReply(reply: unknown): RedisReply {
  if (reply === null || reply === undefined) return { kind: 'nil' };
  if (Buffer.isBuffer(reply)) return { kind: 'bulk', value: toRedisText(reply) };
  if (typeof reply === 'number') return { kind: 'integer', value: reply };
  if (Array.isArray(reply)) return { kind: 'array', items: reply.map(toReply) };
  if (reply instanceof ErrorReply) return { kind: 'error', message: reply.message };
  return { kind: 'status', text: String(reply) };
}

/** A reply in the form checks compare: text, numbers or null. */
export function comparable(reply: unknown): RedisText | number | null {
  if (reply === null || reply === undefined) return null;
  if (Buffer.isBuffer(reply)) return toRedisText(reply);
  return typeof reply === 'number' ? reply : String(reply);
}
