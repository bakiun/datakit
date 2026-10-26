import { messageContains, type KafkaMessage, type KafkaMessagePage, type KafkaMessageQuery, type KafkaPositions } from '@datakit/core';
import type { Admin, Base } from '@platformatic/kafka';
import { NO_END, READ_LIMITS, TopicFetcher, type FetchLimits, type PartitionCursor, type RawRecord } from './fetcher';
import { EARLIEST, LATEST, maxBig, minBig, topicOffsets } from './offsets';
import { headerKey, headerText, PAGE_PAYLOAD_BYTES, plainFormat, toPayload, wireSchemaId } from './payload';
import { readCluster, type TopicState } from './raw';
import type { SchemaCodec } from './schemaRegistry';

/** A page reads at most this much; a text search that stops here reports a partial page. */
const SCAN_MAX_MESSAGES = 20_000;
const SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** Offsets read per partition and pass while searching, shared out over the partitions. */
const SEARCH_CHUNK = 2000;
const MIN_SEARCH_CHUNK = 100;
/** Backward steps double over gaps of compacted logs, up to this many offsets. */
const MAX_STEP = 50_000;
const MAX_PASSES = 40;

const SCHEMA_LABELS = { AVRO: 'Avro', JSON: 'JSON Schema', PROTOBUF: 'Protobuf' } as const;

export interface ReaderClients {
  admin: Admin;
  /**
   * Clients of their own, created on first use: a broker answers the requests of a connection in order, so a long
   * poll of a live stream would hold up everything else sent on it.
   */
  reader(): Base;
  tailer(): Base;
  codec: SchemaCodec | null;
}

/** A partition read backwards: `[lo, cursor)` is still unread. */
interface BackwardScan {
  partition: number;
  lo: bigint;
  cursor: bigint;
  /** Kept records, oldest first. */
  found: RawRecord[];
  want: number;
  step: number;
}

class Budget {
  messages = 0;
  bytes = 0;
  add(records: readonly RawRecord[]): void {
    this.messages += records.length;
    for (const r of records) this.bytes += r.bytes;
  }
  get spent(): boolean {
    return this.messages >= SCAN_MAX_MESSAGES || this.bytes >= SCAN_MAX_BYTES;
  }
}

const newestFirst = (a: RawRecord, b: RawRecord) => b.timestamp - a.timestamp || (a.offset < b.offset ? 1 : a.offset > b.offset ? -1 : b.partition - a.partition);
const oldestFirst = (a: RawRecord, b: RawRecord) => a.timestamp - b.timestamp || a.partition - b.partition || (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0);

function offsetParam(value: string | null, label: string): bigint | null {
  if (value === null || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${label} must be a whole number.`);
  return BigInt(value.trim());
}

/** Message browsing: pages of the newest messages, live tails and full reads. Nothing joins a group or commits. */
export class MessageReader {
  constructor(private readonly clients: ReaderClients) {}

  private async open(name: string, client: Base): Promise<TopicFetcher> {
    const refresh = () => readCluster(this.clients.admin, [name]);
    const cluster = await refresh();
    const topic = cluster.topics.get(name);
    if (!topic) throw new Error(`Topic ${name} does not exist.`);
    return new TopicFetcher(client, topic, cluster.brokers, refresh);
  }

  private offsets(topic: TopicState, partitions: readonly number[], timestamp: bigint): Promise<Map<number, bigint>> {
    return topicOffsets(this.clients.admin, topic, partitions, timestamp);
  }

  async readMessages(query: KafkaMessageQuery): Promise<KafkaMessagePage> {
    const { records, scanned, partial, positions, matched } = await this.newest(query);
    const messages = await Promise.all(records.map((r) => matched.get(r) ?? this.toMessage(r, PAGE_PAYLOAD_BYTES)));
    return { messages, scanned, partial, positions };
  }

  /** The newest records that match the query, newest first, and what reading them took. */
  private async newest(query: KafkaMessageQuery) {
    const limit = Math.max(1, Math.floor(query.limit));
    const fetcher = await this.open(query.topic, this.clients.reader());
    const topic = fetcher.state;
    const all = topic.partitions.map((p) => p.partition);
    if (query.partition !== null && !all.includes(query.partition)) {
      throw new Error(`Partition ${query.partition} does not exist; ${topic.name} has ${all.length} partition${all.length === 1 ? '' : 's'}.`);
    }
    const chosen = query.partition === null ? all : [query.partition];
    const fromOffset = offsetParam(query.fromOffset, 'The first offset');
    const toOffset = offsetParam(query.toOffset, 'The last offset');
    const [starts, ends, fromTimes, toTimes] = await Promise.all([
      this.offsets(topic, chosen, EARLIEST),
      this.offsets(topic, all, LATEST),
      query.fromTime === null ? null : this.offsets(topic, chosen, BigInt(query.fromTime)),
      // The first offset after the range ends it.
      query.toTime === null ? null : this.offsets(topic, chosen, BigInt(query.toTime) + 1n),
    ]);
    const positions: KafkaPositions = {};
    for (const [partition, end] of ends) positions[String(partition)] = end.toString();

    const scans: BackwardScan[] = [];
    for (const partition of chosen) {
      let lo = starts.get(partition);
      let hi = ends.get(partition);
      if (lo === undefined || hi === undefined) continue;
      if (fromOffset !== null) lo = maxBig(lo, fromOffset);
      if (toOffset !== null) hi = minBig(hi, toOffset + 1n);
      const fromTime = fromTimes?.get(partition);
      if (fromTimes) lo = fromTime === undefined || fromTime < 0n ? hi : maxBig(lo, fromTime);
      const toTime = toTimes?.get(partition);
      if (toTime !== undefined && toTime >= 0n) hi = minBig(hi, toTime);
      if (lo < hi) scans.push({ partition, lo, cursor: hi, found: [], want: 0, step: 0 });
    }

    // Timestamps need not grow with offsets, so the time range is also checked on each record.
    const inTime = (r: RawRecord) => (query.fromTime === null || r.timestamp >= query.fromTime) && (query.toTime === null || r.timestamp <= query.toTime);
    const budget = new Budget();
    const matched = new Map<RawRecord, KafkaMessage>();
    const text = query.text?.trim() ? query.text : null;
    let partial = false;

    if (text === null) {
      const quota = query.partition !== null ? limit : Math.ceil(limit / Math.max(1, scans.length));
      for (const s of scans) s.want = s.step = quota;
      await this.scanBack(fetcher, scans, budget, async (r) => inTime(r), () => false);
      // Quota a partition could not use goes, once, to the partitions that have more.
      const unused = scans.filter((s) => s.cursor <= s.lo).reduce((n, s) => n + Math.max(0, s.want), 0);
      const more = scans.filter((s) => s.cursor > s.lo);
      if (unused > 0 && more.length) {
        const extra = Math.ceil(unused / more.length);
        for (const s of more) s.want = s.step = extra;
        await this.scanBack(fetcher, more, budget, async (r) => inTime(r), () => false);
      }
    } else {
      const chunk = Math.max(MIN_SEARCH_CHUNK, Math.ceil(SEARCH_CHUNK / Math.max(1, scans.length)));
      for (const s of scans) {
        s.want = limit;
        s.step = chunk;
      }
      const matches = async (r: RawRecord) => {
        if (!inTime(r)) return false;
        // Searched whole; kept cut short for the page.
        if (!messageContains(await this.toMessage(r, null), text)) return false;
        matched.set(r, await this.toMessage(r, PAGE_PAYLOAD_BYTES));
        return true;
      };
      await this.scanBack(fetcher, scans, budget, matches, () => matched.size >= limit);
      partial = budget.spent && matched.size < limit && scans.some((s) => s.cursor > s.lo);
    }

    const records = scans
      .flatMap((s) => s.found)
      .sort(newestFirst)
      .slice(0, limit);
    return { records, scanned: budget.messages, partial, positions, matched };
  }

  /** Reads each scan backwards in growing steps until it has what it wants, reaches its start, or the budget is spent. */
  private async scanBack(
    fetcher: TopicFetcher,
    scans: BackwardScan[],
    budget: Budget,
    keep: (r: RawRecord) => Promise<boolean>,
    enough: () => boolean,
  ): Promise<void> {
    for (let pass = 0; pass < MAX_PASSES && !budget.spent && !enough(); pass++) {
      const active = scans.filter((s) => s.want > 0 && s.cursor > s.lo);
      if (!active.length) return;
      // A pass reads no more than the budget has left, shared out.
      const room = Math.max(1, Math.ceil((SCAN_MAX_MESSAGES - budget.messages) / active.length));
      const ranges = active.map((s) => ({ scan: s, from: maxBig(s.lo, s.cursor - BigInt(Math.min(s.step, room))) }));
      const records = await this.readRanges(
        fetcher,
        ranges.map(({ scan, from }) => ({ partition: scan.partition, next: from, end: scan.cursor })),
      );
      budget.add(records);
      const byPartition = new Map<number, RawRecord[]>();
      for (const r of records) {
        if (!(await keep(r))) continue;
        const kept = byPartition.get(r.partition);
        if (kept) kept.push(r);
        else byPartition.set(r.partition, [r]);
      }
      for (const { scan, from } of ranges) {
        const kept = byPartition.get(scan.partition) ?? [];
        scan.found = [...kept, ...scan.found];
        scan.want -= kept.length;
        scan.cursor = from;
        scan.step = Math.min(scan.step * 2, MAX_STEP);
      }
    }
  }

  /** Reads every cursor to its end; records come in log order per partition. */
  private async readRanges(fetcher: TopicFetcher, cursors: PartitionCursor[], limits: FetchLimits = READ_LIMITS): Promise<RawRecord[]> {
    const records: RawRecord[] = [];
    while (cursors.some((c) => c.next < c.end)) {
      const round = await fetcher.round(cursors, limits);
      records.push(...round.records);
      await this.moveIntoLog(fetcher.state, round.outOfRange, false);
    }
    return records;
  }

  /**
   * Cursors before the start of the log, whose messages retention deleted meanwhile, move to its start; cursors
   * past its end end there, or for a live stream restart there.
   */
  private async moveIntoLog(topic: TopicState, cursors: PartitionCursor[], follow: boolean): Promise<void> {
    if (!cursors.length) return;
    const partitions = cursors.map((c) => c.partition);
    const [starts, ends] = await Promise.all([this.offsets(topic, partitions, EARLIEST), this.offsets(topic, partitions, LATEST)]);
    for (const cursor of cursors) {
      const start = starts.get(cursor.partition) ?? cursor.next;
      const end = ends.get(cursor.partition) ?? cursor.next;
      if (cursor.next < start) cursor.next = minBig(start, cursor.end);
      else if (follow) cursor.next = end;
      else cursor.end = cursor.next;
    }
  }

  async tail(topicName: string, positions: KafkaPositions, waitMs: number): Promise<{ messages: KafkaMessage[]; positions: KafkaPositions }> {
    const fetcher = await this.open(topicName, this.clients.tailer());
    const topic = fetcher.state;
    const all = topic.partitions.map((p) => p.partition);
    // Partitions added since the page was read start at their current end.
    const added = all.filter((p) => positions[String(p)] === undefined);
    const ends = added.length ? await this.offsets(topic, added, LATEST) : new Map<number, bigint>();
    const cursors: PartitionCursor[] = [];
    for (const partition of all) {
      const known = positions[String(partition)];
      const next = known !== undefined ? BigInt(known) : ends.get(partition);
      if (next !== undefined) cursors.push({ partition, next, end: NO_END });
    }
    const round = await fetcher.round(cursors, { ...READ_LIMITS, maxWaitMs: Math.max(0, Math.floor(waitMs)) });
    await this.moveIntoLog(topic, round.outOfRange, true);
    const messages = await Promise.all(round.records.sort(oldestFirst).map((r) => this.toMessage(r, PAGE_PAYLOAD_BYTES)));
    const next: KafkaPositions = { ...positions };
    for (const cursor of cursors) next[String(cursor.partition)] = cursor.next.toString();
    return { messages, positions: next };
  }

  async readAll(topicName: string, onChunk: (messages: KafkaMessage[], read: number, total: number) => Promise<boolean> | boolean): Promise<number> {
    const fetcher = await this.open(topicName, this.clients.reader());
    const topic = fetcher.state;
    const all = topic.partitions.map((p) => p.partition);
    const [starts, ends] = await Promise.all([this.offsets(topic, all, EARLIEST), this.offsets(topic, all, LATEST)]);
    const cursors: PartitionCursor[] = [];
    let total = 0;
    for (const partition of all) {
      const start = starts.get(partition);
      const end = ends.get(partition);
      if (start === undefined || end === undefined || start >= end) continue;
      cursors.push({ partition, next: start, end });
      total += Number(end - start);
    }
    let read = 0;
    while (cursors.some((c) => c.next < c.end)) {
      const round = await fetcher.round(cursors, READ_LIMITS);
      await this.moveIntoLog(topic, round.outOfRange, false);
      if (!round.records.length) continue;
      const messages = await Promise.all(round.records.sort(oldestFirst).map((r) => this.toMessage(r, null)));
      read += messages.length;
      if (!(await onChunk(messages, read, total))) break;
    }
    return read;
  }

  async sampleFormat(topic: string): Promise<string | null> {
    const query: KafkaMessageQuery = { topic, limit: 10, partition: null, fromOffset: null, toOffset: null, fromTime: null, toTime: null, text: null };
    const value = (await this.newest(query)).records.find((r) => r.value !== null)?.value;
    if (!value) return null;
    const id = wireSchemaId(value);
    if (id === null) return plainFormat(value);
    const codec = this.clients.codec;
    const schema = codec ? await codec.schema(id) : null;
    if (!codec || !schema) return 'Schema Registry';
    const label = SCHEMA_LABELS[schema.type];
    if (schema.type === 'PROTOBUF') return label;
    try {
      const versions = await codec.registry.versionsOfId(id);
      const version = (versions.find((v) => v.subject === `${topic}-value`) ?? versions[0])?.version;
      return version === undefined ? label : `${label} · v${version}`;
    } catch {
      return label;
    }
  }

  private async decoded(bytes: Buffer | null): Promise<string | null> {
    const id = bytes === null ? null : wireSchemaId(bytes);
    return id === null || !this.clients.codec ? null : this.clients.codec.decode(bytes!, id);
  }

  /** A record made readable; payloads cut to `maxBytes` when set. */
  async toMessage(r: RawRecord, maxBytes: number | null): Promise<KafkaMessage> {
    const [key, value] = await Promise.all([this.decoded(r.key), this.decoded(r.value)]);
    return {
      partition: r.partition,
      offset: r.offset.toString(),
      timestamp: r.timestamp,
      key: r.key === null ? null : toPayload(r.key, maxBytes, key),
      value: r.value === null ? null : toPayload(r.value, maxBytes, value),
      headers: r.headers.map(([k, v]) => ({ key: headerKey(k), value: headerText(v) })),
    };
  }
}
