import { FetchIsolationLevels, type Base, type fetchV17 } from '@platformatic/kafka';
import { protocolError, responseOf } from './errors';
import { brokerConnection, getApi, retryOnce, type ClusterState, type TopicState } from './raw';

type FetchResponse = fetchV17.FetchResponse;
type FetchTopic = fetchV17.FetchRequestTopic;
type FetchArgs = [maxWaitMs: number, minBytes: number, maxBytes: number, isolationLevel: number, sessionId: number, sessionEpoch: number, topics: FetchTopic[], forgotten: [], rackId: string];

/** A record as read from the log, before it is made readable. */
export interface RawRecord {
  partition: number;
  offset: bigint;
  /** Milliseconds since the epoch. */
  timestamp: number;
  key: Buffer | null;
  value: Buffer | null;
  headers: [Buffer | null, Buffer | null][];
  /** Key, value and header bytes. */
  bytes: number;
}

/** A partition read from `next` up to, not including, `end`. */
export interface PartitionCursor {
  partition: number;
  next: bigint;
  end: bigint;
}

export interface FetchLimits {
  /** How long the broker may wait for new records; 0 answers at once. */
  maxWaitMs: number;
  partitionMaxBytes: number;
  maxBytes: number;
}

/** For reading what is there: no waiting. */
export const READ_LIMITS: FetchLimits = { maxWaitMs: 0, partitionMaxBytes: 1024 * 1024, maxBytes: 8 * 1024 * 1024 };
/** No end: a cursor that follows the log. */
export const NO_END = 2n ** 63n - 1n;

const IS_CONTROL = 0x20;
const LOG_APPEND_TIME = 0x08;
const OFFSET_OUT_OF_RANGE = 1;
/** The metadata is stale: the leader moved or the topic changed. */
const STALE_METADATA = new Set([3, 5, 6, 56, 74, 75]);
/** Rounds in which a partition below the high watermark got nothing before it is given up. */
const MAX_IDLE_ROUNDS = 3;

/**
 * Reads partitions of one topic with sessionless Fetch requests to each partition's leader: no consumer group,
 * nothing committed. A fetch from an offset returns the whole batch holding it, and compacted logs have gaps, so
 * records outside a cursor's range are dropped and cursors advance past each batch read.
 */
export class TopicFetcher {
  private readonly idle = new Map<number, number>();

  constructor(
    private readonly client: Base,
    private topic: TopicState,
    private brokers: ClusterState['brokers'],
    private readonly refresh: () => Promise<ClusterState>,
  ) {}

  get state(): TopicState {
    return this.topic;
  }

  /**
   * One Fetch per leader for the open cursors; advances them and returns the records read in log order per
   * partition. Cursors whose offset is no longer in the log are returned for the caller to move.
   */
  async round(cursors: readonly PartitionCursor[], limits: FetchLimits): Promise<{ records: RawRecord[]; outOfRange: PartitionCursor[] }> {
    for (let attempt = 0; ; attempt++) {
      const { records, outOfRange, stale } = await this.tryRound(cursors, limits);
      if (!stale.length || records.length) return { records, outOfRange };
      if (attempt >= 2) {
        // Still no leader to read from: a bounded read gives these partitions up rather than wait.
        for (const cursor of stale) if (cursor.end !== NO_END) cursor.end = cursor.next;
        return { records, outOfRange };
      }
      const cluster = await this.refresh();
      const topic = cluster.topics.get(this.topic.name);
      if (!topic) throw new Error(`Topic ${this.topic.name} does not exist.`);
      this.topic = topic;
      this.brokers = cluster.brokers;
    }
  }

  private async tryRound(cursors: readonly PartitionCursor[], limits: FetchLimits) {
    const open = cursors.filter((c) => c.next < c.end);
    const byLeader = new Map<number, PartitionCursor[]>();
    const stale: PartitionCursor[] = [];
    for (const cursor of open) {
      const leader = this.topic.partitions[cursor.partition]?.leader ?? -1;
      if (!this.brokers.has(leader)) {
        stale.push(cursor);
        continue;
      }
      const group = byLeader.get(leader);
      if (group) group.push(cursor);
      else byLeader.set(leader, [cursor]);
    }
    const records: RawRecord[] = [];
    const outOfRange: PartitionCursor[] = [];
    if (!byLeader.size) return { records, outOfRange, stale };

    const api = await getApi<FetchArgs, FetchResponse>(this.client, 'Fetch');
    // Fetch v13 names topics by id, older versions by name.
    const topicId = api.version <= 12 ? this.topic.name : this.topic.id;
    const responses = await Promise.all(
      [...byLeader].map(async ([leader, group]) => {
        // Partitions that got nothing last time go first: the broker always fills the first one it can.
        group.sort((a, b) => (this.idle.get(b.partition) ?? 0) - (this.idle.get(a.partition) ?? 0));
        const partitions = group.map((c) => ({
          partition: c.partition,
          currentLeaderEpoch: -1,
          fetchOffset: c.next,
          lastFetchedEpoch: -1,
          partitionMaxBytes: limits.partitionMaxBytes,
        }));
        const broker = this.brokers.get(leader)!;
        return retryOnce(async () => {
          const connection = await brokerConnection(this.client, broker);
          try {
            // Session id 0 and epoch -1: a full fetch that opens no fetch session on the broker.
            return await api.async(connection, limits.maxWaitMs, 1, limits.maxBytes, FetchIsolationLevels.READ_UNCOMMITTED, 0, -1, [{ topicId, partitions }], [], '');
          } catch (error) {
            const partial = responseOf<FetchResponse>(error);
            if (partial?.responses) return partial;
            throw error;
          }
        });
      }),
    );

    const byPartition = new Map(open.map((c) => [c.partition, c]));
    for (const response of responses) {
      for (const topic of response.responses) {
        for (const p of topic.partitions) {
          const cursor = byPartition.get(p.partitionIndex);
          if (!cursor) continue;
          if (p.errorCode === OFFSET_OUT_OF_RANGE) {
            outOfRange.push(cursor);
            continue;
          }
          if (STALE_METADATA.has(p.errorCode)) {
            stale.push(cursor);
            continue;
          }
          if (p.errorCode !== 0) throw protocolError(p.errorCode);
          const advanced = this.take(cursor, p.records ?? [], records);
          if (advanced) {
            this.idle.delete(cursor.partition);
          } else if (cursor.next >= p.highWatermark && cursor.end !== NO_END) {
            // Nothing left below the high watermark, e.g. after the log was truncated.
            cursor.end = cursor.next;
          } else if (cursor.end !== NO_END) {
            const rounds = (this.idle.get(cursor.partition) ?? 0) + 1;
            this.idle.set(cursor.partition, rounds);
            if (rounds >= MAX_IDLE_ROUNDS) cursor.end = cursor.next;
          }
        }
      }
    }
    return { records, outOfRange, stale };
  }

  /** Collects the records of the batches inside the cursor's range; returns whether the cursor moved. */
  private take(cursor: PartitionCursor, batches: fetchV17.FetchResponsePartition['records'] & object, into: RawRecord[]): boolean {
    let next = cursor.next;
    for (const batch of batches) {
      if (!(batch.attributes & IS_CONTROL)) {
        for (const record of batch.records) {
          const offset = batch.firstOffset + BigInt(record.offsetDelta);
          if (offset < cursor.next || offset >= cursor.end) continue;
          const timestamp = batch.attributes & LOG_APPEND_TIME ? batch.maxTimestamp : batch.firstTimestamp + record.timestampDelta;
          let bytes = (record.key?.length ?? 0) + (record.value?.length ?? 0);
          for (const [k, v] of record.headers) bytes += (k?.length ?? 0) + (v?.length ?? 0);
          into.push({ partition: cursor.partition, offset, timestamp: Number(timestamp), key: record.key, value: record.value, headers: record.headers, bytes });
        }
      }
      const after = batch.firstOffset + BigInt(batch.lastOffsetDelta) + 1n;
      if (after > next) next = after;
    }
    if (next <= cursor.next) return false;
    cursor.next = next > cursor.end ? cursor.end : next;
    return true;
  }
}
