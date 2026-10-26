import type { Environment } from '../dataSource';
import type { RedisEdit } from '../redis/edits';
import type { RedisDatabase, RedisKeyDetail, RedisKeyInfo, RedisPageStart, RedisText, RedisValuePage } from '../redis/types';

/** Messages between the extension and the Redis key browser webview. */

export interface RedisKeysInit {
  dataSourceName: string;
  environment: Environment;
  /** e.g. `Redis 8.0.1` */
  serverLabel: string;
  usedMemory: string | null;
  tls: boolean;
  readOnly: boolean;
  database: number;
  databases: RedisDatabase[];
  /** Keys per SCAN round and items per value page. */
  pageSize: number;
  /** The COUNT hint SCAN gets when the command does not give one. */
  scanCount: number;
  /** HEXPIRE and friends exist (Redis 7.4+), so hashes show a TTL per field. */
  fieldTtl: boolean;
  /** SET … KEEPTTL exists (Redis 6+); otherwise a string write sets the shown TTL again. */
  keepTtl: boolean;
}

export type RedisExportFormat = 'json' | 'csv';

export const REDIS_EXPORT_FORMATS: readonly { value: RedisExportFormat; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'csv', label: 'CSV' },
];

export type RedisKeysHostMessage =
  | { type: 'init'; init: RedisKeysInit }
  | { type: 'initFailed'; message: string }
  /** Keys found by a scan; `append` adds them to the list of the previous round. `cursor` is `'0'` at the end. */
  | { type: 'keys'; keys: RedisKeyInfo[]; cursor: string; total: number; append: boolean }
  | { type: 'keysFailed'; message: string }
  /** A key with a page of its value; `append` adds the rows to those shown. */
  | { type: 'key'; detail: RedisKeyDetail; page: RedisValuePage; append: boolean }
  /** The key does not exist (any more). */
  | { type: 'keyGone'; key: RedisText }
  | { type: 'keyFailed'; message: string }
  /** An edit was written; `commands` are echoed in the CLI. `key` is the key to show now, e.g. after a rename. */
  | { type: 'written'; commands: string[]; key: RedisText | null; summary: string }
  | { type: 'writeFailed'; message: string }
  | { type: 'database'; database: number; databases: RedisDatabase[] }
  /** The reply to a CLI line; `wrote` when the command changes data, so the page reloads what it shows. */
  | { type: 'cli'; line: string; output: string; ok: boolean; durationMs: number; wrote: boolean }
  | { type: 'notice'; message: string };

export type RedisKeysWebviewMessage =
  | { type: 'ready' }
  /**
   * Scans from `cursor`; `append` adds the keys to those shown, for “Load more”. `count` is the COUNT hint, null for
   * the data source's default.
   */
  | { type: 'scan'; match: string; keyType: string | null; cursor: string; count: number | null; append: boolean }
  | { type: 'open'; key: RedisText }
  /** The next page of the open key's value. */
  | { type: 'more'; key: RedisText; start: RedisPageStart }
  | { type: 'edit'; edit: RedisEdit }
  | { type: 'select'; database: number }
  | { type: 'cli'; line: string }
  | { type: 'export'; key: RedisText; format: RedisExportFormat }
  | { type: 'copy'; text: string };
