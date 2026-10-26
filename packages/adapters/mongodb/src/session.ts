import type { SshTunnel } from '@datakit/adapter-common';
import type {
  MongoCollectionInfo,
  MongoDatabaseInfo,
  MongoDocument,
  MongoEdit,
  MongoExplain,
  MongoExportQuery,
  MongoFindQuery,
  MongoIndex,
  MongoPage,
  MongoSchema,
  MongoSession,
  MongoShellPlan,
  MongoShellResult,
  MongoWriteResult,
  ServerVersion,
} from '@datakit/core';
import {
  BSON,
  MongoServerError,
  type CollationOptions,
  type Collection,
  type CollectionInfo,
  type CreateIndexesOptions,
  type Document,
  type Filter,
  type FindOptions,
  type MongoClient,
  type Sort,
} from 'mongodb';
import { parseCollation, parseFilter, parseProject, parseSort } from 'mongodb-query-parser';
import { listDatabases, visibleCollections } from './databases';
import { summarizeExplain } from './explain';
import { analyzeSchema } from './schema';
import { planShellLine, runShellLine } from './shell';
import { idFromText, idToText, isDocument, parseDocument, parsePipeline, parseWith, shellLine, shellText, toMongoDocument, writingStage } from './values';

const QUERY_TIME_MS = 60_000;
const COUNT_TIME_MS = 5_000;
/** Counts for the collection list run a few at a time, which keeps a database with hundreds of collections fast. */
const COUNT_CONCURRENCY = 8;
const EXPORT_BATCH = 1000;
const CODE_UNAUTHORIZED = 13;
const CODE_NAMESPACE_NOT_FOUND = 26;
const CODE_NOT_SUPPORTED_ON_VIEW = 166;

/** Reads keep every BSON number type, so documents print and edit as they are stored. */
const EXACT = { promoteValues: false } as const;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function collectionType(info: CollectionInfo): MongoCollectionInfo['type'] {
  return info.type === 'view' ? 'view' : info.type === 'timeseries' ? 'timeseries' : 'collection';
}

function toCollectionInfo(info: CollectionInfo, documents: number | null, bytes: number | null): MongoCollectionInfo {
  const options = info.options ?? {};
  const type = collectionType(info);
  return {
    name: info.name,
    type,
    documents: type === 'view' ? null : documents,
    bytes: type === 'view' ? null : bytes,
    capped: options.capped === true,
    viewOn: typeof options.viewOn === 'string' ? options.viewOn : null,
    pipeline: Array.isArray(options.pipeline) ? shellText(options.pipeline) : null,
  };
}

/** The parts of a query bar; an empty text is none, and errors name the part. */
function parseFind(query: MongoFindQuery | MongoExportQuery) {
  const filter = parseWith('Filter', query.filter, parseFilter);
  if (!isDocument(filter)) throw new Error('Filter: Give a document, e.g. { status: "A" }.');
  const projection = parseWith('Projection', query.projection, parseProject);
  if (projection !== null && !isDocument(projection)) throw new Error('Projection: Give a document, e.g. { name: 1, email: 1 }.');
  const sort = parseWith('Sort', query.sort, parseSort);
  if (sort !== null && !isDocument(sort) && !Array.isArray(sort)) throw new Error('Sort: Give a document, e.g. { created: -1 }.');
  const collationText = 'collation' in query ? query.collation : '';
  const collation = parseWith('Collation', collationText, parseCollation);
  if (collation !== null && !isDocument(collation)) throw new Error('Collation: Give a document, e.g. { locale: "en", strength: 2 }.');
  return {
    filter,
    projection: projection ?? undefined,
    sort: (sort ?? undefined) as Sort | undefined,
    collation: (collation ?? undefined) as CollationOptions | undefined,
  };
}

/** The filter and find options of a query bar. */
function findOptions(query: MongoFindQuery): { filter: Document; options: FindOptions } {
  const { filter, projection, sort, collation } = parseFind(query);
  const options: FindOptions = { maxTimeMS: QUERY_TIME_MS };
  if (projection) options.projection = projection;
  if (sort) options.sort = sort;
  if (collation) options.collation = collation;
  if (query.skip > 0) options.skip = query.skip;
  if (query.limit > 0) options.limit = query.limit;
  return { filter, options };
}

/** Finds documents by `_id`s of any BSON type, which the driver's types do not foresee. */
const byId = (id: string): Filter<Document> => ({ _id: idFromText(id) }) as Filter<Document>;
const byIds = (ids: readonly string[]): Filter<Document> => ({ _id: { $in: ids.map(idFromText) } }) as Filter<Document>;

function isEmptyDocument(document: Document): boolean {
  return Object.keys(document).length === 0;
}

function refuseWritingStages(stages: readonly Document[]): void {
  if (writingStage(stages)) throw new Error('Pipelines with $out or $merge write data; run them in the shell.');
}

/** An open connection to a MongoDB deployment. The driver reconnects by itself, so the session ends only on `close()`. */
export class MongoClientSession implements MongoSession {
  readonly kind = 'mongodb';
  private ended = false;
  private readonly listeners: ((error?: Error) => void)[] = [];

  constructor(
    private readonly client: MongoClient,
    private readonly tunnel: SshTunnel | undefined,
    readonly serverVersion: ServerVersion,
    readonly topology: string,
    /** The database on the General tab, listed even when the user may not list databases. */
    private readonly defaultDatabase: string,
  ) {
    tunnel?.onDidClose((error) => {
      this.end(error ?? new Error('The SSH tunnel was closed.'));
      void this.client.close().catch(() => undefined);
    });
  }

  private collectionOf(database: string, name: string): Collection {
    return this.client.db(database).collection(name);
  }

  async databases(): Promise<MongoDatabaseInfo[]> {
    const databases = await listDatabases(this.client);
    if (this.defaultDatabase && !databases.some((d) => d.name === this.defaultDatabase)) {
      databases.push({ name: this.defaultDatabase, sizeOnDisk: null, empty: true });
    }
    return databases.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async listCollections(database: string, filter: Document = {}): Promise<CollectionInfo[]> {
    const db = this.client.db(database);
    try {
      return (await db.listCollections(filter, { nameOnly: false, authorizedCollections: true }).toArray()) as CollectionInfo[];
    } catch (error) {
      // Without the listCollections privilege only the names (and types) of the collections the user may read are listed.
      if (!(error instanceof MongoServerError) || error.code !== CODE_UNAUTHORIZED) throw error;
      return (await db.listCollections(filter, { nameOnly: true, authorizedCollections: true }).toArray()) as CollectionInfo[];
    }
  }

  private async estimatedCount(database: string, info: CollectionInfo): Promise<number | null> {
    if (collectionType(info) === 'view') return null;
    try {
      return await this.collectionOf(database, info.name).estimatedDocumentCount({ maxTimeMS: COUNT_TIME_MS });
    } catch {
      return null;
    }
  }

  async collections(database: string): Promise<MongoCollectionInfo[]> {
    const shown = visibleCollections(await this.listCollections(database));
    shown.sort((a, b) => a.name.localeCompare(b.name));
    const counts = await mapLimit(shown, COUNT_CONCURRENCY, (info) => this.estimatedCount(database, info));
    return shown.map((info, i) => toCollectionInfo(info, counts[i]!, null));
  }

  async collection(database: string, name: string): Promise<MongoCollectionInfo | null> {
    const [info] = await this.listCollections(database, { name });
    if (!info) return null;
    if (collectionType(info) === 'view') return toCollectionInfo(info, null, null);
    const [documents, bytes] = await Promise.all([this.estimatedCount(database, info), this.storageSize(database, name)]);
    return toCollectionInfo(info, documents, bytes);
  }

  /** `$collStats` storage statistics, one per shard. */
  private async storageStats(database: string, name: string): Promise<Document[] | null> {
    try {
      const stats = await this.collectionOf(database, name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
      return stats.map((s) => (isDocument(s.storageStats) ? s.storageStats : {}));
    } catch {
      return null;
    }
  }

  private async storageSize(database: string, name: string): Promise<number | null> {
    const stats = await this.storageStats(database, name);
    return stats ? stats.reduce((sum, s) => sum + (Number(s.storageSize) || 0), 0) : null;
  }

  private async count(collection: Collection, filter: Document, collation: CollationOptions | undefined): Promise<number | null> {
    try {
      if (isEmptyDocument(filter)) return await collection.estimatedDocumentCount({ maxTimeMS: COUNT_TIME_MS });
      return await collection.countDocuments(filter, { maxTimeMS: COUNT_TIME_MS, ...(collation ? { collation } : {}) });
    } catch {
      // Counting a large collection with a filter that no index serves takes too long; the page works without it.
      return null;
    }
  }

  async find(database: string, collection: string, query: MongoFindQuery): Promise<MongoPage> {
    const { filter, options } = findOptions(query);
    const target = this.collectionOf(database, collection);
    const [documents, count] = await Promise.all([target.find(filter, { ...options, ...EXACT }).toArray(), this.count(target, filter, options.collation)]);
    return { documents: documents.map(toMongoDocument), count };
  }

  async aggregate(database: string, collection: string, pipeline: string, limit: number): Promise<MongoPage> {
    const stages = parsePipeline('Pipeline', pipeline);
    refuseWritingStages(stages);
    const run = limit > 0 ? [...stages, { $limit: limit }] : stages;
    const documents = await this.collectionOf(database, collection).aggregate(run, { ...EXACT, maxTimeMS: QUERY_TIME_MS }).toArray();
    return { documents: documents.map(toMongoDocument), count: null };
  }

  async explain(database: string, collection: string, query: MongoFindQuery | { pipeline: string }): Promise<MongoExplain> {
    const target = this.collectionOf(database, collection);
    if ('pipeline' in query) {
      const stages = parsePipeline('Pipeline', query.pipeline);
      refuseWritingStages(stages);
      return summarizeExplain(await target.aggregate(stages, { maxTimeMS: QUERY_TIME_MS }).explain('executionStats'));
    }
    const { filter, options } = findOptions(query);
    return summarizeExplain(await target.find(filter, options).explain('executionStats'));
  }

  async document(database: string, collection: string, id: string): Promise<MongoDocument | null> {
    const document = await this.collectionOf(database, collection).findOne(byId(id), EXACT);
    return document ? toMongoDocument(document) : null;
  }

  async indexes(database: string, collection: string): Promise<MongoIndex[]> {
    const target = this.collectionOf(database, collection);
    let specs: Document[];
    try {
      specs = await target.listIndexes().toArray();
    } catch (error) {
      // Views have no indexes, and a collection that does not exist yet has none either.
      if (error instanceof MongoServerError && (error.code === CODE_NOT_SUPPORTED_ON_VIEW || error.code === CODE_NAMESPACE_NOT_FOUND)) return [];
      throw error;
    }
    const [usage, storage] = await Promise.all([
      target
        .aggregate([{ $indexStats: {} }])
        .toArray()
        .catch(() => null),
      this.storageStats(database, collection),
    ]);
    return specs.map((spec) => {
      const name = String(spec.name);
      // A cluster reports each index once per shard.
      const uses = usage?.filter((u) => u.name === name) ?? [];
      const sizes = storage?.map((s) => (isDocument(s.indexSizes) ? s.indexSizes[name] : undefined)).filter((size) => size !== undefined) ?? [];
      const since = uses.map((u) => (u.accesses?.since instanceof Date ? u.accesses.since.getTime() : null)).filter((t): t is number => t !== null);
      return {
        name,
        keys: shellLine(spec.key),
        unique: spec.unique === true,
        sparse: spec.sparse === true,
        hidden: spec.hidden === true,
        ttlSeconds: asNumber(spec.expireAfterSeconds),
        partialFilter: isDocument(spec.partialFilterExpression) ? shellLine(spec.partialFilterExpression) : null,
        bytes: sizes.length ? sizes.reduce((sum: number, size) => sum + Number(size), 0) : null,
        ops: usage ? uses.reduce((sum, u) => sum + Number(u.accesses?.ops ?? 0), 0) : null,
        usageSince: since.length ? Math.min(...since) : null,
      };
    });
  }

  async schema(database: string, collection: string, sample: number): Promise<MongoSchema> {
    const documents = await this.collectionOf(database, collection)
      .aggregate([{ $sample: { size: Math.max(1, Math.floor(sample)) } }], { ...EXACT, maxTimeMS: QUERY_TIME_MS })
      .toArray();
    return analyzeSchema(documents);
  }

  async write(database: string, collection: string, edit: MongoEdit): Promise<MongoWriteResult> {
    const target = this.collectionOf(database, collection);
    const none: string[] = [];
    switch (edit.kind) {
      case 'insert': {
        const value = parseWith('Document', edit.text);
        if (Array.isArray(value)) {
          if (!value.length || !value.every(isDocument)) throw new Error('Document: Give a document or an array of documents.');
          const result = await target.insertMany(value);
          const ids = Object.values(result.insertedIds).map(idToText);
          return { summary: `Inserted ${plural(result.insertedCount, 'document')}`, affected: result.insertedCount, insertedIds: ids };
        }
        if (!isDocument(value)) throw new Error('Document: Give a document or an array of documents.');
        const result = await target.insertOne(value);
        return { summary: 'Inserted 1 document', affected: 1, insertedIds: [idToText(result.insertedId)] };
      }
      case 'replace': {
        const document = parseDocument('Document', edit.text);
        if (Object.hasOwn(document, '_id') && idToText(document._id) !== edit.id) throw new Error('The _id cannot be changed.');
        const result = await target.replaceOne(byId(edit.id), document);
        return this.updated(result.matchedCount, result.modifiedCount);
      }
      case 'setField': {
        const value = parseWith('Value', edit.value);
        const result = await target.updateOne(byId(edit.id), { $set: { [edit.path]: value } });
        return this.updated(result.matchedCount, result.modifiedCount);
      }
      case 'unsetField': {
        const result = await target.updateOne(byId(edit.id), { $unset: { [edit.path]: '' } });
        return this.updated(result.matchedCount, result.modifiedCount);
      }
      case 'delete': {
        if (!edit.ids.length) return { summary: 'Deleted 0 documents', affected: 0, insertedIds: none };
        const result = await target.deleteMany(byIds(edit.ids));
        return { summary: `Deleted ${plural(result.deletedCount, 'document')}`, affected: result.deletedCount, insertedIds: none };
      }
      case 'deleteMatching': {
        const filter = parseDocument('Filter', edit.filter, {});
        if (isEmptyDocument(filter)) throw new Error('Give a filter; use the shell to delete every document.');
        const result = await target.deleteMany(filter);
        return { summary: `Deleted ${plural(result.deletedCount, 'document')}`, affected: result.deletedCount, insertedIds: none };
      }
      case 'updateMatching': {
        const filter = parseDocument('Filter', edit.filter, {});
        const update = parseWith('Update', edit.update);
        if (!isDocument(update) && !(Array.isArray(update) && update.every(isDocument))) {
          throw new Error('Update: Give an update document, e.g. { $set: { status: "A" } }, or a pipeline.');
        }
        const result = await target.updateMany(filter, update);
        return { summary: `Updated ${plural(result.modifiedCount, 'document')}`, affected: result.modifiedCount, insertedIds: none };
      }
      case 'createIndex': {
        const { spec } = edit;
        const keys = parseDocument('Keys', spec.keys);
        if (isEmptyDocument(keys)) throw new Error('Keys: Give at least one field, e.g. { email: 1 }.');
        const options: CreateIndexesOptions = {};
        if (spec.name.trim()) options.name = spec.name.trim();
        if (spec.unique) options.unique = true;
        if (spec.sparse) options.sparse = true;
        if (spec.hidden) options.hidden = true;
        if (spec.ttlSeconds !== null) options.expireAfterSeconds = spec.ttlSeconds;
        if (spec.partialFilter.trim()) options.partialFilterExpression = parseDocument('Partial filter', spec.partialFilter);
        const name = await target.createIndex(keys, options);
        return { summary: `Created index ${name}`, affected: 1, insertedIds: none };
      }
      case 'dropIndex': {
        if (edit.name === '_id_') throw new Error('The _id index cannot be dropped.');
        await target.dropIndex(edit.name);
        return { summary: `Dropped index ${edit.name}`, affected: 1, insertedIds: none };
      }
      case 'hideIndex': {
        await this.client.db(database).command({ collMod: collection, index: { name: edit.name, hidden: edit.hidden } });
        return { summary: `${edit.hidden ? 'Hid' : 'Unhid'} index ${edit.name}`, affected: 1, insertedIds: none };
      }
    }
  }

  /** The result of an edit of one document found by its `_id`. */
  private updated(matched: number, modified: number): MongoWriteResult {
    if (!matched) throw new Error('The document was not found; it may have been deleted.');
    return { summary: `Updated ${plural(modified, 'document')}`, affected: modified, insertedIds: [] };
  }

  async createCollection(database: string, name: string): Promise<void> {
    await this.client.db(database).createCollection(name);
  }

  async dropCollection(database: string, name: string): Promise<void> {
    await this.client.db(database).dropCollection(name);
  }

  async renameCollection(database: string, from: string, to: string): Promise<void> {
    await this.client.db(database).renameCollection(from, to);
  }

  async dropDatabase(database: string): Promise<void> {
    await this.client.db(database).dropDatabase();
  }

  async exportDocuments(
    database: string,
    collection: string,
    query: MongoExportQuery,
    onBatch: (documents: Record<string, unknown>[]) => Promise<boolean> | boolean,
  ): Promise<number> {
    const { filter, projection, sort } = parseFind(query);
    const cursor = this.collectionOf(database, collection).find(filter, {
      ...EXACT,
      batchSize: EXPORT_BATCH,
      ...(projection ? { projection } : {}),
      ...(sort ? { sort } : {}),
    });
    let read = 0;
    let batch: Record<string, unknown>[] = [];
    try {
      for await (const document of cursor) {
        batch.push(BSON.EJSON.serialize(document, { relaxed: true }) as Record<string, unknown>);
        read++;
        if (batch.length === EXPORT_BATCH) {
          const next = batch;
          batch = [];
          if ((await onBatch(next)) === false) return read;
        }
      }
      if (batch.length) await onBatch(batch);
      return read;
    } finally {
      await cursor.close();
    }
  }

  planShell(database: string, line: string): MongoShellPlan {
    return planShellLine(database, line);
  }

  shell(database: string, line: string): Promise<MongoShellResult> {
    return runShellLine(this.client, database, line);
  }

  async close(): Promise<void> {
    if (this.ended) return;
    try {
      await this.client.close();
    } finally {
      this.end();
    }
  }

  onDidClose(listener: (error?: Error) => void): void {
    this.listeners.push(listener);
  }

  private end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.tunnel?.close();
    for (const listener of this.listeners) listener(error);
  }
}
