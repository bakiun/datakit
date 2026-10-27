import type { Environment } from '../dataSource';
import type {
  MongoCollectionInfo,
  MongoCollectionType,
  MongoEdit,
  MongoExplain,
  MongoExportQuery,
  MongoFindQuery,
  MongoIndex,
  MongoPage,
  MongoSchema,
  MongoWriteResult,
} from '../mongo/types';

/** Messages between the extension and the MongoDB collection webview: one tab per collection. */

export interface MongoCollectionInit {
  dataSourceName: string;
  environment: Environment;
  /** e.g. `MongoDB 8.0.4` */
  serverLabel: string;
  /** e.g. `Replica set rs0` */
  topology: string;
  database: string;
  collection: string;
  type: MongoCollectionType;
  readOnly: boolean;
  /** Documents per page: the last size picked for the data source, else the one of its Options tab. */
  pageSize: number;
  info: MongoCollectionInfo;
  /** The choices made in the last collection tab, so a new tab starts with them. */
  prefs: MongoCollectionPrefs;
}

export type MongoExportFormat = 'json' | 'jsonl' | 'csv';

export type MongoDocumentsView = 'list' | 'table' | 'json';

/** Choices a collection tab remembers for the next one. */
export interface MongoCollectionPrefs {
  /** How the Documents tab shows the documents. */
  view: MongoDocumentsView;
  /** Documents the schema analysis samples. */
  schemaSample: number;
  exportFormat: MongoExportFormat;
}

export const DEFAULT_MONGO_COLLECTION_PREFS: MongoCollectionPrefs = { view: 'list', schemaSample: 1000, exportFormat: 'json' };

export const MONGO_EXPORT_FORMATS: readonly { value: MongoExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON (array)' },
  { value: 'jsonl', label: 'JSON Lines' },
  { value: 'csv', label: 'CSV (top-level fields)' },
];

export type MongoEditKind = MongoEdit['kind'];

export type MongoCollectionHostMessage =
  | { type: 'init'; init: MongoCollectionInit }
  | { type: 'initFailed'; message: string }
  /** The answer to `find` or `aggregate`; `requestId` lets the page drop answers to older requests. */
  | { type: 'page'; requestId: number; page: MongoPage; durationMs: number }
  | { type: 'pageFailed'; requestId: number; message: string }
  | { type: 'explain'; explain: MongoExplain }
  | { type: 'explainFailed'; message: string }
  | { type: 'indexes'; indexes: MongoIndex[] }
  | { type: 'schema'; schema: MongoSchema }
  /** Fresh counts and sizes, e.g. after a write. */
  | { type: 'info'; info: MongoCollectionInfo }
  | { type: 'loadFailed'; what: 'indexes' | 'schema' | 'info'; message: string }
  /** An edit was written; the page reloads what it shows. */
  | { type: 'written'; kind: MongoEditKind; result: MongoWriteResult }
  /**
   * Refused (read-only, cancelled in VS Code's confirmation) or failed on the server. `cancelled` when the user said
   * no in the confirmation: the page leaves things as they were, without an error.
   */
  | { type: 'writeFailed'; kind: MongoEditKind; message: string; cancelled?: boolean }
  /** The answer to a shell line; `wrote` when it may have changed data, so the page reloads. */
  | { type: 'shell'; line: string; output: string; ok: boolean; durationMs: number; database: string; wrote: boolean }
  | { type: 'notice'; message: string; error?: boolean };

export type MongoCollectionWebviewMessage =
  | { type: 'ready' }
  | { type: 'find'; requestId: number; query: MongoFindQuery }
  /** `pipeline` is an array of stages in shell syntax. */
  | { type: 'aggregate'; requestId: number; pipeline: string; limit: number }
  | { type: 'explain'; query: MongoFindQuery | { pipeline: string } }
  /** `sample` is how many documents the schema analysis reads; 1,000 when left out. */
  | { type: 'load'; what: 'indexes' | 'schema' | 'info'; sample?: number }
  /** Deletions are confirmed by the page; production data sources ask again in VS Code. */
  | { type: 'edit'; edit: MongoEdit }
  | { type: 'shell'; line: string }
  /** Saves every document the query matches, not only the shown page. */
  | { type: 'export'; query: MongoExportQuery; format: MongoExportFormat }
  /** Copies text the page put together; `what` is named in the status bar. */
  | { type: 'copy'; text: string; what: string }
  /** A choice to keep for the next tab; `pageSize` is kept for this data source. */
  | { type: 'remember'; prefs: Partial<MongoCollectionPrefs> & { pageSize?: number } };
