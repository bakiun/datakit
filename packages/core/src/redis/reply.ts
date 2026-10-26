import type { RedisReply, RedisText } from './types';

/** A bulk string the way redis-cli quotes it: escapes for quotes, backslashes and control characters. */
function quoted(value: RedisText): string {
  if (typeof value !== 'string') return `"${value.hex.replace(/../g, (byte) => `\\x${byte}`)}"`;
  const escaped = value.replace(/[\\"\n\r\t\x07\b]|[\x00-\x1f\x7f]/g, (c) => {
    const named: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\x07': '\\a', '\b': '\\b' };
    return named[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });
  return `"${escaped}"`;
}

/** Formats a reply like redis-cli does on a terminal: `(integer) 1`, `"text"`, numbered and nested arrays. */
export function formatReply(reply: RedisReply): string {
  switch (reply.kind) {
    case 'status':
      return reply.text;
    case 'error':
      return `(error) ${reply.message}`;
    case 'integer':
      return `(integer) ${reply.value}`;
    case 'bulk':
      return quoted(reply.value);
    case 'nil':
      return '(nil)';
    case 'array': {
      if (!reply.items.length) return '(empty array)';
      const width = String(reply.items.length).length;
      return reply.items
        .map((item, i) => {
          const label = `${String(i + 1).padStart(width)}) `;
          const [first = '', ...rest] = formatReply(item).split('\n');
          return [label + first, ...rest.map((line) => ' '.repeat(label.length) + line)].join('\n');
        })
        .join('\n');
    }
  }
}

/** A short description of a reply for the CLI status, e.g. `14 items`. */
export function describeReply(reply: RedisReply): string {
  if (reply.kind === 'array') return `${reply.items.length} item${reply.items.length === 1 ? '' : 's'}`;
  return reply.kind === 'error' ? 'error' : reply.kind;
}
