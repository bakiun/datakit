import type { Connector, KafkaMessage, KafkaOverview, KafkaTopicSummary } from './types';

/** Kafka's rules for topic names; null when the name is valid and free. */
export function topicNameProblem(name: string, existing: readonly string[]): string | null {
  const n = name.trim();
  if (!n) return 'Name the topic.';
  if (n.length > 249) return 'Topic names are at most 249 characters.';
  if (n === '.' || n === '..') return 'A topic cannot be named “.” or “..”.';
  if (!/^[a-zA-Z0-9._-]+$/.test(n)) return 'Letters, digits, dot, dash and underscore only.';
  if (existing.includes(n)) return 'This topic already exists.';
  // Kafka treats . and _ alike in metric names, so it refuses names that differ only there.
  const metricName = (t: string) => t.replace(/\./g, '_');
  const clash = existing.find((t) => metricName(t) === metricName(n));
  if (clash) return `“${clash}” differs only in . and _, which Kafka does not allow.`;
  return null;
}

const UNITS: readonly [label: string, ms: number][] = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['min', 60_000],
  ['s', 1000],
];

/** `7 d`, `12 h`, `90 s`; milliseconds that are not a whole unit stay in ms. -1 is `forever`. */
export function formatDuration(ms: number): string {
  if (ms < 0) return 'forever';
  for (const [label, size] of UNITS) if (ms >= size && ms % size === 0) return `${ms / size} ${label}`;
  return `${ms} ms`;
}

/** The retention column: `7 d`, `forever`, `compact`, or `7 d · compact` for compact,delete. */
export function retentionLabel(topic: Pick<KafkaTopicSummary, 'retentionMs' | 'cleanupPolicy'>): string {
  const policies = topic.cleanupPolicy.split(',').map((p) => p.trim());
  const compact = policies.includes('compact');
  if (compact && !policies.includes('delete')) return 'compact';
  const time = topic.retentionMs === null ? '—' : formatDuration(topic.retentionMs);
  return compact ? `${time} · compact` : time;
}

/** Retention choices of the Create topic dialog, as `retention.ms` values. */
export const RETENTION_CHOICES: readonly { label: string; ms: number }[] = [
  { label: '1 day', ms: 86_400_000 },
  { label: '7 days', ms: 604_800_000 },
  { label: '30 days', ms: 2_592_000_000 },
  { label: 'Forever', ms: -1 },
];

/** Whether a key, value or header of the message contains `text`, ignoring case. */
export function messageContains(message: KafkaMessage, text: string): boolean {
  const needle = text.toLowerCase();
  const has = (value: string | null | undefined) => !!value && value.toLowerCase().includes(needle);
  return (
    has(message.key?.text) ||
    has(message.value?.text) ||
    has(message.value?.decoded) ||
    message.headers.some((h) => has(h.key) || has(h.value))
  );
}

/** -1, 0 or 1, comparing int64 offsets written as decimal strings. */
export function compareOffsets(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface KafkaHealthItem {
  level: 'warning' | 'error';
  /** Short text for the health strip, e.g. `1 out-of-sync replica`. */
  summary: string;
  /** Longer line for the expanded health log. */
  detail: string;
}

const count = (n: number, word: string, plural = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : plural}`;

/** What needs attention in the cluster: offline and under-replicated partitions, lagging groups, failed connectors. */
export function kafkaHealth(overview: KafkaOverview, connectors: readonly Connector[] | null): KafkaHealthItem[] {
  const items: KafkaHealthItem[] = [];
  if (overview.offline.length) {
    const first = overview.offline[0]!;
    items.push({
      level: 'error',
      summary: count(overview.offline.length, 'offline partition'),
      detail: `${first.topic} p${first.partition} has no leader${overview.offline.length > 1 ? `, and ${count(overview.offline.length - 1, 'more partition')}` : ''}`,
    });
  }
  const missing = overview.underReplicated.reduce((n, p) => n + p.replicas.filter((r) => !p.isr.includes(r)).length, 0);
  if (missing) {
    const first = overview.underReplicated[0]!;
    items.push({
      level: 'warning',
      summary: count(missing, 'out-of-sync replica'),
      detail: `${first.topic} p${first.partition} ISR [${first.isr.join(',')}] of replicas [${first.replicas.join(',')}]`,
    });
  }
  const offlineBrokers = overview.brokers.filter((b) => !b.online);
  if (offlineBrokers.length) {
    items.push({
      level: 'error',
      summary: count(offlineBrokers.length, 'broker offline', 'brokers offline'),
      detail: `${offlineBrokers.map((b) => `broker-${b.id}`).join(', ')} hold replicas but are not in the cluster`,
    });
  }
  const lagOf = (g: KafkaOverview['groups'][number]) => Object.values(g.lagByTopic).reduce<number>((n, l) => n + (l ?? 0), 0);
  const lagging = overview.groups.map((g) => ({ group: g, lag: lagOf(g) })).filter((g) => g.lag > 0).sort((a, b) => b.lag - a.lag);
  if (lagging.length) {
    const top = lagging[0]!;
    items.push({
      level: 'warning',
      summary: `max lag ${top.lag.toLocaleString('en-US')} · ${top.group.id}`,
      detail: `${top.group.id} lags ${top.lag.toLocaleString('en-US')} messages behind on ${Object.keys(top.group.lagByTopic).join(', ')} (${top.group.state})`,
    });
  }
  const failed = (connectors ?? []).flatMap((c) => [
    ...(c.state === 'FAILED' ? [{ connector: c.name, task: null as number | null }] : []),
    ...c.tasks.filter((t) => t.state === 'FAILED').map((t) => ({ connector: c.name, task: t.id as number | null })),
  ]);
  if (failed.length) {
    const first = failed[0]!;
    items.push({
      level: 'error',
      summary: count(failed.length, 'connector task failed', 'connector tasks failed'),
      detail: `connector ${first.connector}${first.task === null ? '' : ` task ${first.task}`} FAILED`,
    });
  }
  return items;
}
