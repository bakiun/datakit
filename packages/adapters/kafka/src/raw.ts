import {
  kGetApi,
  kGetBootstrapConnection,
  kGetConnection,
  NetworkError,
  type API,
  type Base,
  type Broker,
  type Connection,
  type describeConfigsV4,
  type metadataV12,
} from '@platformatic/kafka';
import { responseOf } from './errors';

/*
 * Requests the Admin client does not offer, or offers only with retries and all-or-nothing answers, are sent
 * with the driver's own API implementations: it picks the newest version both sides support.
 */

export function getApi<A extends unknown[], R>(client: Base, name: string): Promise<API<A, R>> {
  return new Promise((resolve, reject) => client[kGetApi]<A, R>(name, (error, api) => (error ? reject(error) : resolve(api!))));
}

/** A connection to the first bootstrap or known broker that answers. */
export function anyConnection(client: Base): Promise<Connection> {
  return new Promise((resolve, reject) => client[kGetBootstrapConnection]((error, connection) => (error ? reject(error) : resolve(connection!))));
}

export function brokerConnection(client: Base, broker: Broker): Promise<Connection> {
  return new Promise((resolve, reject) => client[kGetConnection](broker, (error, connection) => (error ? reject(error) : resolve(connection!))));
}

/** Retries once when the connection dropped, e.g. after the broker closed an idle one. */
export async function retryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!NetworkError.isRetryable(error as Error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return run();
  }
}

export interface BrokerNode extends Broker {
  id: number;
  rack: string | null;
}

export interface PartitionState {
  partition: number;
  /** -1 without a leader. */
  leader: number;
  replicas: number[];
  isr: number[];
}

export interface TopicState {
  name: string;
  /** The topic UUID; the name on brokers too old to report ids. */
  id: string;
  internal: boolean;
  /** By partition number. */
  partitions: PartitionState[];
}

export interface ClusterState {
  clusterId: string;
  controllerId: number;
  brokers: Map<number, BrokerNode>;
  topics: Map<string, TopicState>;
}

type MetadataResponse = metadataV12.MetadataResponse;
/** Topic errors that still come with usable partitions, e.g. right after a topic was created. */
const USABLE_TOPIC_ERRORS = new Set([0, 5]);

/** Brokers and topics with their partitions in one Metadata request; null reads every topic. */
export async function readCluster(client: Base, topics: string[] | null): Promise<ClusterState> {
  const response = await retryOnce(async () => {
    const api = await getApi<[string[] | null, boolean, boolean], MetadataResponse>(client, 'Metadata');
    const connection = await anyConnection(client);
    try {
      return await api.async(connection, topics, false, false);
    } catch (error) {
      // A partition without a leader fails the request; its answer is still complete.
      const partial = responseOf<MetadataResponse>(error);
      if (partial?.brokers) return partial;
      throw error;
    }
  });
  const brokers = new Map<number, BrokerNode>();
  for (const b of response.brokers) brokers.set(b.nodeId, { id: b.nodeId, host: b.host, port: b.port, rack: b.rack ?? null });
  const states = new Map<string, TopicState>();
  for (const t of response.topics) {
    if (!t.name || !USABLE_TOPIC_ERRORS.has(t.errorCode)) continue;
    const partitions = t.partitions
      .map((p) => ({ partition: p.partitionIndex, leader: p.leaderId, replicas: p.replicaNodes, isr: p.isrNodes }))
      .sort((a, b) => a.partition - b.partition);
    const id = !t.topicId || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(t.topicId) ? t.name : t.topicId;
    states.set(t.name, { name: t.name, id, internal: t.isInternal, partitions });
  }
  return { clusterId: response.clusterId ?? '', controllerId: response.controllerId, brokers, topics: states };
}

export type ConfigResult = describeConfigsV4.DescribeConfigsResponseResult;
type DescribeConfigsResponse = describeConfigsV4.DescribeConfigsResponse;
type ConfigResource = describeConfigsV4.DescribeConfigsRequestResource;

/**
 * DescribeConfigs on one broker, keeping the results of resources that did not fail. Topic configs can be read
 * on any broker; the configs of a broker only on that broker.
 */
export async function describeConfigs(client: Base, resources: ConfigResource[], documentation: boolean, broker?: Broker): Promise<ConfigResult[]> {
  if (!resources.length) return [];
  return retryOnce(async () => {
    const api = await getApi<[ConfigResource[], boolean, boolean], DescribeConfigsResponse>(client, 'DescribeConfigs');
    const connection = broker ? await brokerConnection(client, broker) : await anyConnection(client);
    try {
      return (await api.async(connection, resources, false, documentation)).results;
    } catch (error) {
      const partial = responseOf<DescribeConfigsResponse>(error);
      if (partial?.results) return partial.results;
      throw error;
    }
  });
}
