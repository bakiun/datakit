import type { KafkaGroupOffset, KafkaOffsetTarget } from '@datakit/core';
import { formatTime, offsetText } from './format';

/** Topics a reset confirmation lists; the rest are counted. */
const MAX_TOPICS = 8;

/** What moving a group's committed offsets does, in words for its confirmation. */
export interface ResetSummary {
  /** Where the offsets go: `the earliest offset`, or `offset` with `value` `1,800`. */
  to: string;
  /** The typed time or offset, shown unbroken; null for earliest and latest. */
  value: string | null;
  /** Some partition does not have the typed offset, so it gets its nearest one. */
  clamped: boolean;
  /** The topics and their partitions, e.g. `partitions 0–2, 5`; at most MAX_TOPICS, `more` counts the rest. */
  topics: { topic: string; partitions: string }[];
  more: number;
  /** What the group's consumers do next, with the number of messages when the offsets tell it. */
  effect: string;
}

const clamp = (n: bigint, low: bigint, high: bigint) => (n < low ? low : n > high ? high : n);
const messages = (n: bigint) => `${offsetText(n.toString())} ${n === 1n ? 'message' : 'messages'}`;

/** `partition 3`, `partitions 0–2, 5, 7–9`. */
export function partitionList(partitions: number[]): string {
  const sorted = [...new Set(partitions)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i]!;
    while (sorted[i + 1] === sorted[i]! + 1) i++;
    const last = sorted[i]!;
    runs.push(last === first ? `${first}` : last === first + 1 ? `${first}, ${last}` : `${first}–${last}`);
  }
  return `${sorted.length === 1 ? 'partition' : 'partitions'} ${runs.join(', ')}`;
}

/** Where a partition's offset lands. A time is left out: only the server can turn it into an offset. */
function landing(row: KafkaGroupOffset, target: Exclude<KafkaOffsetTarget, { kind: 'timestamp' }>): bigint {
  const start = BigInt(row.start);
  const end = BigInt(row.end);
  switch (target.kind) {
    case 'earliest':
      return start;
    case 'latest':
      return end;
    case 'offset':
      return clamp(BigInt(target.offset), start, end);
  }
}

/** What consumers do after the move; counted from the committed, start and end offsets the page already has. */
function effectOf(rows: KafkaGroupOffset[], target: KafkaOffsetTarget): string {
  if (target.kind === 'timestamp') return 'Consumers in this group will continue from that time, reading again or skipping the messages between it and where they are now.';
  const known = rows.filter((row) => row.committed !== null);
  if (!known.length) return 'Consumers in this group will start from there.';
  let again = 0n;
  let skipped = 0n;
  for (const row of known) {
    // A committed offset outside the partition resumes from its nearest end.
    const now = clamp(BigInt(row.committed!), BigInt(row.start), BigInt(row.end));
    const next = landing(row, target);
    if (next < now) again += now - next;
    else skipped += next - now;
  }
  if (again && skipped) return `Consumers in this group will read ${messages(again)} again and skip ${offsetText(skipped.toString())} they have not read yet.`;
  if (again) return `Consumers in this group will read ${messages(again)} again.`;
  if (skipped) return `Consumers in this group will skip ${messages(skipped)} they have not read yet.`;
  return 'The offsets are already there, so no message is read again or skipped.';
}

/** Describes moving a group's offsets on `rows` to `target`. */
export function describeReset(rows: KafkaGroupOffset[], target: KafkaOffsetTarget): ResetSummary {
  const byTopic = new Map<string, number[]>();
  for (const row of rows) byTopic.set(row.topic, [...(byTopic.get(row.topic) ?? []), row.partition]);
  const topics = [...byTopic].slice(0, MAX_TOPICS).map(([topic, partitions]) => ({ topic, partitions: partitionList(partitions) }));
  const where =
    target.kind === 'timestamp'
      ? { to: 'the first message at or after', value: formatTime(target.time) }
      : target.kind === 'offset'
        ? { to: 'offset', value: offsetText(target.offset) }
        : { to: `the ${target.kind} offset`, value: null };
  const wanted = target.kind === 'offset' ? BigInt(target.offset) : null;
  const clamped = wanted !== null && rows.some((row) => wanted < BigInt(row.start) || wanted > BigInt(row.end));
  return { ...where, clamped, topics, more: Math.max(0, byTopic.size - MAX_TOPICS), effect: effectOf(rows, target) };
}
