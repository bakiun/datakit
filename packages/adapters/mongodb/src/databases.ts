import type { MongoDatabaseInfo } from '@datakit/core';
import { MongoServerError, type CollectionInfo, type Document, type MongoClient } from 'mongodb';

const CODE_UNAUTHORIZED = 13;

/** The databases of the deployment; users without the listDatabases privilege get the ones they may read, without sizes. */
export async function listDatabases(client: MongoClient): Promise<MongoDatabaseInfo[]> {
  const admin = client.db('admin');
  try {
    const reply = await admin.command({ listDatabases: 1 });
    return (reply.databases as Document[]).map((d) => ({
      name: String(d.name),
      sizeOnDisk: d.sizeOnDisk === undefined || d.sizeOnDisk === null ? null : Number(d.sizeOnDisk),
      empty: d.empty === true,
    }));
  } catch (error) {
    if (!(error instanceof MongoServerError) || error.code !== CODE_UNAUTHORIZED) throw error;
    const reply = await admin.command({ listDatabases: 1, authorizedDatabases: true, nameOnly: true });
    return (reply.databases as Document[]).map((d) => ({ name: String(d.name), sizeOnDisk: null, empty: false }));
  }
}

/**
 * Leaves out the collections the server keeps for itself: `system.views` holds the view definitions, and a time series
 * collection keeps its data in `system.buckets.<name>`, which it stands for.
 */
export function visibleCollections<T extends Pick<CollectionInfo, 'name' | 'type'>>(infos: readonly T[]): T[] {
  const timeseries = new Set(infos.filter((info) => info.type === 'timeseries').map((info) => info.name));
  return infos.filter((info) => info.name !== 'system.views' && !(info.name.startsWith('system.buckets.') && timeseries.has(info.name.slice('system.buckets.'.length))));
}
