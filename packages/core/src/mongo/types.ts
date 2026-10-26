import type { ServerSession } from '../sql/session';

/**
 * MongoDB in Datakit. Values cross the wire as text in shell syntax (`ObjectId("…")`, `ISODate("…")`,
 * `NumberLong("…")`), which is what users type in filters and editors and what the adapter parses with
 * mongodb-query-parser. An `_id` that edits use to find a document again travels as canonical Extended JSON,
 * which keeps its exact BSON type.
 */

/** BSON type names shown in the UI, close to the aliases `$type` uses. */
export type MongoBsonType =
  | 'ObjectId'
  | 'String'
  | 'Int32'
  | 'Int64'
  | 'Double'
  | 'Decimal128'
  | 'Boolean'
  | 'Date'
  | 'Null'
  | 'Undefined'
  | 'Object'
  | 'Array'
  | 'Binary'
  | 'UUID'
  | 'RegExp'
  | 'Timestamp'
  | 'MinKey'
  | 'MaxKey'
  | 'Code'
  | 'Symbol'
  | 'DBRef';

export interface MongoDatabaseInfo {
  name: string;
  /** Null when the server does not report it, e.g. without the listDatabases privilege. */
  sizeOnDisk: number | null;
  empty: boolean;
}

export type MongoCollectionType = 'collection' | 'view' | 'timeseries';

export interface MongoCollectionInfo {
  name: string;
  type: MongoCollectionType;
  /** The estimated document count; null for views and when it could not be read. */
  documents: number | null;
  /** Storage size in bytes; null for views and when it could not be read. */
  bytes: number | null;
  capped: boolean;
  /** For views: the source collection and the pipeline in shell syntax. */
  viewOn: string | null;
  pipeline: string | null;
}

/** A top-level field of a document, for the table view. */
export interface MongoFieldPreview {
  name: string;
  type: MongoBsonType;
  /** The value in shell syntax, cut to 200 characters. */
  preview: string;
  /** True when `preview` is the whole value, so the cell can be edited in place. */
  complete: boolean;
}

export interface MongoDocument {
  /** The `_id` as canonical Extended JSON; null when the document has none (e.g. aggregation output). */
  id: string | null;
  /** The `_id` in shell syntax. */
  idText: string | null;
  /** The whole document in shell syntax, indented by two spaces. */
  text: string;
  /** True for a document over 1 MiB: `text` holds only its start, and it cannot be edited as a whole here. */
  truncated: boolean;
  fields: MongoFieldPreview[];
  /** BSON size in bytes. */
  size: number;
}

/** A find, as the query bar holds it. Every text is shell syntax; an empty text means none. */
export interface MongoFindQuery {
  filter: string;
  projection: string;
  sort: string;
  collation: string;
  skip: number;
  limit: number;
}

export interface MongoPage {
  documents: MongoDocument[];
  /** Documents matching the filter; null when counting took too long or for aggregations. */
  count: number | null;
}

export interface MongoExplain {
  /** The winning plan's stages from the root down, e.g. `FETCH ← IXSCAN`. */
  stages: string[];
  /** The index the winning plan uses; null for a collection scan. */
  index: string | null;
  returned: number;
  docsExamined: number;
  keysExamined: number;
  timeMs: number;
  /** The whole explain output in shell syntax. */
  text: string;
}

export interface MongoIndex {
  name: string;
  /** The key pattern in shell syntax, e.g. `{ customer: 1, created: -1 }`. */
  keys: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  /** `expireAfterSeconds` of a TTL index. */
  ttlSeconds: number | null;
  /** The partial filter in shell syntax. */
  partialFilter: string | null;
  bytes: number | null;
  /** Uses since `usageSince`, from $indexStats; null when it could not be read. */
  ops: number | null;
  usageSince: number | null;
}

export interface MongoIndexSpec {
  /** The key pattern in shell syntax, e.g. `{ email: 1 }`. */
  keys: string;
  /** Empty lets the server name it. */
  name: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  ttlSeconds: number | null;
  /** Shell syntax; empty for none. */
  partialFilter: string;
}

export interface MongoFieldStats {
  /** Dotted path; array elements are `field[]`, e.g. `items[].sku`. */
  path: string;
  /** Documents of the sample that have the field. */
  count: number;
  /** How often each type occurs, most frequent first. */
  types: { type: MongoBsonType; count: number }[];
  /** Up to three distinct values in shell syntax, cut to 60 characters. */
  examples: string[];
}

export interface MongoSchema {
  /** Documents sampled with $sample. */
  sampled: number;
  fields: MongoFieldStats[];
}

/** Changes to a collection. Texts are shell syntax; ids are canonical Extended JSON from `MongoDocument.id`. */
export type MongoEdit =
  /** One document, or an array of them. */
  | { kind: 'insert'; text: string }
  /** Replaces the whole document; its `_id` must stay the same. */
  | { kind: 'replace'; id: string; text: string }
  /** `$set` of one field, the value in shell syntax; `path` may be dotted. */
  | { kind: 'setField'; id: string; path: string; value: string }
  | { kind: 'unsetField'; id: string; path: string }
  | { kind: 'delete'; ids: string[] }
  /** deleteMany with the filter; an empty filter is refused. */
  | { kind: 'deleteMatching'; filter: string }
  /** updateMany with the filter and an update document or pipeline. */
  | { kind: 'updateMatching'; filter: string; update: string }
  | { kind: 'createIndex'; spec: MongoIndexSpec }
  | { kind: 'dropIndex'; name: string }
  /** Hides or unhides an index from the query planner (MongoDB 4.4+). */
  | { kind: 'hideIndex'; name: string; hidden: boolean };

export interface MongoWriteResult {
  /** What happened, e.g. `Updated 1 document`. */
  summary: string;
  /** Documents or indexes affected. */
  affected: number;
  /** For inserts: the new `_id`s as canonical Extended JSON. */
  insertedIds: string[];
}

/** What a shell line does before it runs: reads run at once, writes may need a confirmation first. */
export interface MongoShellPlan {
  writes: boolean;
  /** e.g. `db.orders.deleteMany({ status: "void" })`, for the confirmation. */
  description: string;
}

export interface MongoShellResult {
  /** The answer as mongosh prints it. */
  output: string;
  ok: boolean;
  /** The database `db` points at after the line, which `use` changes. */
  database: string;
}

export interface MongoExportQuery {
  filter: string;
  projection: string;
  sort: string;
}

/** An open connection to a MongoDB deployment, implemented by the MongoDB adapter. Texts it reads are shell syntax. */
export interface MongoSession extends ServerSession {
  readonly kind: 'mongodb';
  /** e.g. `Replica set rs0`, `Standalone`, `Sharded cluster`. */
  readonly topology: string;
  databases(): Promise<MongoDatabaseInfo[]>;
  collections(database: string): Promise<MongoCollectionInfo[]>;
  /** Null when the collection does not exist. */
  collection(database: string, name: string): Promise<MongoCollectionInfo | null>;
  /** Throws with the parser's message when a text of the query is not valid shell syntax. */
  find(database: string, collection: string, query: MongoFindQuery): Promise<MongoPage>;
  /** Runs the pipeline (an array in shell syntax) and returns up to `limit` documents. */
  aggregate(database: string, collection: string, pipeline: string, limit: number): Promise<MongoPage>;
  explain(database: string, collection: string, query: MongoFindQuery | { pipeline: string }): Promise<MongoExplain>;
  /** Null when no document has the id any more. */
  document(database: string, collection: string, id: string): Promise<MongoDocument | null>;
  indexes(database: string, collection: string): Promise<MongoIndex[]>;
  schema(database: string, collection: string, sample: number): Promise<MongoSchema>;
  write(database: string, collection: string, edit: MongoEdit): Promise<MongoWriteResult>;
  createCollection(database: string, name: string): Promise<void>;
  dropCollection(database: string, name: string): Promise<void>;
  renameCollection(database: string, from: string, to: string): Promise<void>;
  dropDatabase(database: string): Promise<void>;
  /**
   * Hands over every matching document as relaxed Extended JSON, a batch at a time; `onBatch` returns false to stop.
   * Returns the number of documents read.
   */
  exportDocuments(database: string, collection: string, query: MongoExportQuery, onBatch: (documents: Record<string, unknown>[]) => Promise<boolean> | boolean): Promise<number>;
  /** Checks a shell line and says whether it writes; throws with a readable message when it is not supported. */
  planShell(database: string, line: string): MongoShellPlan;
  /** Runs a shell line in `database`; errors come back as output with `ok` false. */
  shell(database: string, line: string): Promise<MongoShellResult>;
}
