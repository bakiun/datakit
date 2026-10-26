import { FetchIsolationLevels, ListOffsetTimestamps, type Admin, type listOffsetsV9 } from '@platformatic/kafka';
import { responseOf } from './errors';
import { brokerConnection, getApi, readCluster, retryOnce, type TopicState } from './raw';

export const EARLIEST = ListOffsetTimestamps.EARLIEST;
export const LATEST = ListOffsetTimestamps.LATEST;

/** Offsets by topic and partition. */
export type OffsetTable = Map<string, Map<number, bigint>>;

type ListOffsetsTopic = listOffsetsV9.ListOffsetsRequestTopic;
type ListOffsetsResponse = listOffsetsV9.ListOffsetsResponse;

/**
 * ListOffsets for many partitions in one round, one request per leader. `timestamp` is EARLIEST, LATEST or a time in
 * milliseconds, which finds the first offset at or after it (-1 when there is none). Partitions without a leader or
 * with an error are left out, so one bad partition does not fail the rest.
 *
 * The Admin client's listOffsets is not used: it reads the metadata again and throws from a socket callback when a
 * topic is missing there, e.g. one that is being deleted or was created a moment ago.
 */
export async function listOffsets(admin: Admin, wanted: { topic: TopicState; partitions: readonly number[] }[], timestamp: bigint): Promise<OffsetTable> {
  const table: OffsetTable = new Map();
  const byLeader = new Map<number, ListOffsetsTopic[]>();
  for (const { topic, partitions } of wanted) {
    for (const partitionIndex of partitions) {
      const leader = topic.partitions[partitionIndex]?.leader ?? -1;
      if (leader < 0) continue;
      const requests = byLeader.get(leader) ?? [];
      let request = requests.find((r) => r.name === topic.name);
      if (!request) requests.push((request = { name: topic.name, partitions: [] }));
      request.partitions.push({ partitionIndex, currentLeaderEpoch: -1, timestamp });
      byLeader.set(leader, requests);
    }
  }
  if (!byLeader.size) return table;
  const { brokers } = await readCluster(admin, []);
  const api = await getApi<[number, number, ListOffsetsTopic[]], ListOffsetsResponse>(admin, 'ListOffsets');
  await Promise.all(
    [...byLeader].map(async ([leader, topics]) => {
      const broker = brokers.get(leader);
      if (!broker) return;
      const response = await retryOnce(async () => {
        const connection = await brokerConnection(admin, broker);
        try {
          return await api.async(connection, -1, FetchIsolationLevels.READ_UNCOMMITTED, topics);
        } catch (error) {
          // Partition errors fail the request; the other partitions' answers are still there.
          const partial = responseOf<ListOffsetsResponse>(error);
          if (partial?.topics) return partial;
          throw error;
        }
      });
      for (const topic of response.topics) {
        const offsets = table.get(topic.name) ?? new Map<number, bigint>();
        for (const p of topic.partitions) if (p.errorCode === 0) offsets.set(p.partitionIndex, p.offset);
        table.set(topic.name, offsets);
      }
    }),
  );
  return table;
}

/** Offsets of the partitions of one topic. */
export async function topicOffsets(admin: Admin, topic: TopicState, partitions: readonly number[], timestamp: bigint): Promise<Map<number, bigint>> {
  return (await listOffsets(admin, [{ topic, partitions }], timestamp)).get(topic.name) ?? new Map();
}

export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
