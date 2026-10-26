import {
  formatCommand,
  planEdit,
  redisTextLabel,
  type HashRow,
  type RedisKeyDetail,
  type RedisKeysHostMessage,
  type RedisKeysWebviewMessage,
  type RedisText,
  type RedisValuePage,
} from '@datakit/core';

/**
 * Plays the extension for the Redis key browser on the dev server, with the keys of the design in memory.
 * Edits change the in-memory keys; a CLI line containing `fail` fails, other lines answer OK.
 */
type Value =
  | { type: 'string'; text: string }
  | { type: 'hash'; rows: HashRow[] }
  | { type: 'list'; items: string[] }
  | { type: 'set'; members: string[] }
  | { type: 'zset'; members: [string, string][] }
  | { type: 'stream'; entries: { id: string; fields: [string, string][] }[] };

interface Key {
  ttl: number | null;
  value: Value;
}

function seed(): Map<string, Key> {
  return new Map<string, Key>([
    [
      'session:8f2a91c4',
      {
        ttl: 1752,
        value: {
          type: 'hash',
          rows: [
            { field: 'user_id', value: '388', ttl: null },
            { field: 'email', value: 'daniel@example.com', ttl: null },
            { field: 'cart', value: '[{"sku":"TS-1024","qty":1,"price":899.0},{"sku":"MG-220","qty":2,"price":149.5}]', ttl: 900 },
            { field: 'prefs', value: '{"theme":"dark","currency":"TRY","notify":{"email":true,"sms":false}}', ttl: null },
            { field: 'locale', value: 'tr-TR', ttl: null },
            { field: 'csrf', value: '9b1e…4d7a', ttl: 300 },
          ],
        },
      },
    ],
    ['user:388:profile', { ttl: null, value: { type: 'string', text: '{"id":388,"name":"Daniel A.","tier":"gold","newsletter":true,"addresses":2}' } }],
    [
      'queue:emails',
      {
        ttl: null,
        value: {
          type: 'list',
          items: ['{"to":"alice.k@example.com","tpl":"order_shipped"}', '{"to":"m.young@example.com","tpl":"receipt"}', '{"to":"p.novak@example.cz","tpl":"receipt"}'],
        },
      },
    ],
    ['leaderboard:weekly', { ttl: 183604, value: { type: 'zset', members: [['user:1042', '9820'], ['user:388', '9115'], ['user:77', '8740']] } }],
    ['feature:flags', { ttl: null, value: { type: 'set', members: ['new_checkout', 'dark_invoices', 'beta_search'] } }],
    ['rate:ip:10.0.4.31', { ttl: 38, value: { type: 'string', text: '47' } }],
    ['events:orders', { ttl: null, value: { type: 'stream', entries: [{ id: '1729760000000-0', fields: [['order', '1137'], ['status', 'paid']] }] } }],
  ]);
}

export function installRedisKeysHost(reply: (message: RedisKeysHostMessage, delay?: number) => void): (message: RedisKeysWebviewMessage) => void {
  const keys = seed();
  const readOnly = new URLSearchParams(location.search).has('readonly');
  const name = (key: RedisText) => redisTextLabel(key);
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

  function detailOf(key: string): RedisKeyDetail | null {
    const k = keys.get(key);
    if (!k) return null;
    const v = k.value;
    const length = v.type === 'string' ? v.text.length : v.type === 'hash' ? v.rows.length : v.type === 'list' ? v.items.length : v.type === 'stream' ? v.entries.length : v.members.length;
    return { key, type: v.type, ttl: k.ttl, length, size: 64 + length * 24, encoding: v.type === 'list' ? 'quicklist' : v.type === 'string' ? 'embstr' : 'listpack' };
  }

  function pageOf(key: string): RedisValuePage {
    const v = keys.get(key)!.value;
    switch (v.type) {
      case 'string':
        return { type: 'string', value: v.text, length: v.text.length, truncated: false };
      case 'hash':
        return { type: 'hash', rows: v.rows, next: null };
      case 'list':
        return { type: 'list', rows: v.items.map((value, index) => ({ index, value })), next: null };
      case 'set':
        return { type: 'set', rows: v.members.map((member) => ({ member })), next: null };
      case 'zset':
        return { type: 'zset', rows: v.members.map(([member, score]) => ({ member, score })), next: null };
      case 'stream':
        return { type: 'stream', rows: v.entries, next: null };
    }
  }

  function open(key: string): void {
    const detail = detailOf(key);
    if (!detail) reply({ type: 'keyGone', key }, 100);
    else reply({ type: 'key', detail, page: pageOf(key), append: false }, 150);
  }

  /** Applies an edit to the in-memory keys; returns the key to show afterwards. */
  function apply(message: Extract<RedisKeysWebviewMessage, { type: 'edit' }>['edit']): string | null {
    const key = 'key' in message ? name(message.key) : '';
    const v = keys.get(key)?.value;
    switch (message.kind) {
      case 'setString':
        if (v?.type === 'string') v.text = message.value;
        break;
      case 'hashSet':
        if (v?.type === 'hash') {
          const row = v.rows.find((r) => r.field === message.field);
          if (row) row.value = message.value;
          else v.rows.push({ field: name(message.field), value: message.value, ttl: null });
        }
        break;
      case 'hashRenameField':
        if (v?.type === 'hash') v.rows = v.rows.map((r) => (r.field === message.from ? { ...r, field: message.to } : r));
        break;
      case 'hashFieldTtl':
        if (v?.type === 'hash') v.rows = v.rows.map((r) => (r.field === message.field ? { ...r, ttl: message.ttl } : r));
        break;
      case 'hashDelete':
        if (v?.type === 'hash') v.rows = v.rows.filter((r) => !message.fields.includes(r.field));
        break;
      case 'listSet':
        if (v?.type === 'list') v.items[message.index] = message.value;
        break;
      case 'listPush':
        if (v?.type === 'list') v.items.push(message.value);
        break;
      case 'listDelete':
        if (v?.type === 'list') v.items = v.items.filter((_, i) => !message.items.some((item) => item.index === i));
        break;
      case 'setAdd':
        if (v?.type === 'set') v.members.push(message.member);
        break;
      case 'setRename':
        if (v?.type === 'set') v.members = v.members.map((m) => (m === message.from ? message.to : m));
        break;
      case 'setDelete':
      case 'zsetDelete':
        if (v?.type === 'set') v.members = v.members.filter((m) => !message.members.includes(m));
        if (v?.type === 'zset') v.members = v.members.filter(([m]) => !message.members.includes(m));
        break;
      case 'zsetAdd':
        if (v?.type === 'zset') {
          const member = name(message.member);
          const added: [string, string] = [member, message.score];
          v.members = [...v.members.filter(([m]) => m !== member), added].sort((a, b) => Number(a[1]) - Number(b[1]));
        }
        break;
      case 'zsetRename':
        if (v?.type === 'zset') v.members = v.members.map(([m, s]): [string, string] => (m === message.from ? [message.to, s] : [m, s]));
        break;
      case 'streamAdd':
        if (v?.type === 'stream') v.entries.push({ id: `${Date.now()}-0`, fields: message.fields });
        break;
      case 'streamDelete':
        if (v?.type === 'stream') v.entries = v.entries.filter((e) => !message.ids.includes(e.id));
        break;
      case 'renameKey':
        keys.set(message.to, keys.get(key)!);
        keys.delete(key);
        return message.to;
      case 'expire':
        keys.get(key)!.ttl = message.ttl;
        break;
      case 'deleteKeys':
        for (const k of message.keys) keys.delete(name(k));
        return null;
      case 'createKey': {
        const values: Record<string, Value> = {
          string: { type: 'string', text: message.first },
          hash: { type: 'hash', rows: [{ field: message.first, value: message.second, ttl: null }] },
          list: { type: 'list', items: [message.first] },
          set: { type: 'set', members: [message.first] },
          zset: { type: 'zset', members: [[message.first, message.second]] },
          stream: { type: 'stream', entries: [{ id: `${Date.now()}-0`, fields: [[message.first, message.second]] }] },
        };
        keys.set(message.key, { ttl: message.ttl, value: values[message.type]! });
        return message.key;
      }
    }
    return key;
  }

  return (message) => {
    switch (message.type) {
      case 'ready':
        reply({
          type: 'init',
          init: {
            dataSourceName: 'session-cache',
            environment: 'development',
            serverLabel: 'Redis 7.4.1',
            usedMemory: '412.50M',
            tls: true,
            readOnly,
            database: 0,
            databases: Array.from({ length: 16 }, (_, index) => ({ index, keys: index === 0 ? keys.size : index === 3 ? 12 : 0 })),
            pageSize: 100,
            scanCount: 500,
            fieldTtl: true,
            keepTtl: true,
          },
        });
        break;
      case 'scan': {
        const re = glob(message.match);
        const found = [...keys.entries()]
          .filter(([k, v]) => re.test(k) && (!message.keyType || v.value.type === message.keyType))
          .map(([key, v]) => ({ key, type: v.value.type, ttl: v.ttl }));
        reply({ type: 'keys', keys: found, cursor: '0', total: keys.size, append: message.append }, 200);
        break;
      }
      case 'open':
        open(name(message.key));
        break;
      case 'more':
        break;
      case 'edit': {
        const commands = planEdit(message.edit).commands.map((c) => formatCommand(c));
        const next = apply(message.edit);
        reply({ type: 'written', commands, key: next, summary: 'OK' }, 150);
        if (next !== null) open(next);
        break;
      }
      case 'select':
        reply({ type: 'database', database: message.database, databases: Array.from({ length: 16 }, (_, index) => ({ index, keys: index === 0 ? keys.size : 0 })) }, 100);
        break;
      case 'cli':
        if (/fail|kesy/i.test(message.line)) {
          const [name, first] = message.line.split(/\s+/);
          const output = `(error) ERR unknown command '${name}', with args beginning with: '${first ?? ''}' `;
          reply({ type: 'cli', line: message.line, output, ok: false, durationMs: 0.2, wrote: false }, 100);
        } else reply({ type: 'cli', line: message.line, output: 'OK', ok: true, durationMs: 0.4, wrote: false }, 100);
        break;
      case 'export':
        reply({ type: 'notice', message: `Saved the value as ${message.format} (dev host).` }, 100);
        break;
      case 'copy':
        reply({ type: 'notice', message: 'Copied to the clipboard.' });
        break;
    }
  };
}
