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
  /** Documents per page, from the Options tab. */
  pageSize: number;
  info: MongoCollectionInfo;
}

export type MongoExportFormat = 'json' | 'jsonl' | 'csv';

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
  /** Refused (read-only, cancelled in VS Code's confirmation) or failed on the server. */
  | { type: 'writeFailed'; kind: MongoEditKind; message: string }
  /** The answer to a shell line; `wrote` when it may have changed data, so the page reloads. */
  | { type: 'shell'; line: string; output: string; ok: boolean; durationMs: number; database: string; wrote: boolean }
  | { type: 'notice'; message: string };

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
  /** Copies text the page put together; `what` is named in the confirmation. */
  | { type: 'copy'; text: string; what: string };
