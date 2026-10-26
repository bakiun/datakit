import type { CancelSignal, KsqlColumn, KsqlDbClient, KsqlDbInfo, KsqlResult } from '@datakit/core';
import { RestClient } from './rest';

const KSQL_JSON = 'application/vnd.ksql.v1+json';
const DELIMITED = 'application/vnd.ksqlapi.delimited.v1';

/** The statement without leading whitespace and comments. */
function withoutLeadingComments(statement: string): string {
  let s = statement;
  for (;;) {
    s = s.trimStart();
    if (s.startsWith('--')) {
      const end = s.indexOf('\n');
      s = end < 0 ? '' : s.slice(end + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/');
      s = end < 0 ? '' : s.slice(end + 2);
    } else {
      return s;
    }
  }
}

/** Whether ksqlDB runs the statement as a query that streams rows; PRINT is not one. */
export function isKsqlQuery(statement: string): boolean {
  return /^select\b/i.test(withoutLeadingComments(statement));
}

/** An error line of a query stream, e.g. `{"@type":"generic_error","message":"…"}`. */
function streamError(line: Record<string, unknown>): string | null {
  const message = line['errorMessage'] ?? (line['@type'] !== undefined ? line['message'] : undefined);
  if (message === undefined) return null;
  return typeof message === 'string' ? message : JSON.stringify(message);
}

export class KsqlDbRestClient implements KsqlDbClient {
  private readonly rest: RestClient;
  private readonly stream: RestClient;

  constructor(
    readonly url: string,
    timeoutMs: number,
  ) {
    this.rest = new RestClient('ksqlDB', url, timeoutMs, KSQL_JSON);
    // A push query runs until it is stopped, so only the connection is bounded.
    this.stream = new RestClient('ksqlDB', url, 2 ** 31 - 1, DELIMITED);
  }

  async info(): Promise<KsqlDbInfo> {
    const [info, lists] = await Promise.all([
      this.rest.json<{ KsqlServerInfo: { version: string } }>('/info'),
      this.statement('SHOW STREAMS; SHOW TABLES; SHOW QUERIES;', {}),
    ]);
    const count = (key: string) => (lists as Record<string, unknown[]>[]).reduce((n, entry) => n + (Array.isArray(entry[key]) ? entry[key].length : 0), 0);
    return { version: info.KsqlServerInfo.version, streams: count('streams'), tables: count('tables'), queries: count('queries') };
  }

  private statement(ksql: string, properties: Record<string, string>): Promise<unknown> {
    const text = /;\s*$/.test(ksql) ? ksql : `${ksql.trimEnd()};`;
    return this.rest.json<unknown>('/ksql', { method: 'POST', body: { ksql: text, streamsProperties: properties } });
  }

  async run(
    statement: string,
    properties: Record<string, string>,
    handlers: { onColumns(columns: KsqlColumn[]): void; onRows(rows: unknown[][]): void },
    signal: CancelSignal,
  ): Promise<KsqlResult> {
    if (!isKsqlQuery(statement)) return { kind: 'statement', text: JSON.stringify(await this.statement(statement, properties), null, 2) };
    if (signal.aborted) return { kind: 'query', rows: 0 };

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort);
    let rows = 0;
    let queryId: string | null = null;
    try {
      const response = await this.stream.send('/query-stream', { method: 'POST', body: { sql: statement, properties }, signal: abort.signal });
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      let columns = false;
      const take = (line: string) => {
        if (!line.trim()) return;
        const parsed = JSON.parse(line) as unknown;
        if (Array.isArray(parsed)) {
          rows++;
          return parsed;
        }
        const object = parsed as Record<string, unknown>;
        const error = streamError(object);
        if (error) throw new Error(`ksqlDB: ${error}`);
        if (!columns && Array.isArray(object['columnNames'])) {
          columns = true;
          queryId = typeof object['queryId'] === 'string' ? object['queryId'] : null;
          const names = object['columnNames'] as string[];
          const types = (object['columnTypes'] ?? []) as string[];
          handlers.onColumns(names.map((name, i) => ({ name, type: types[i] ?? '' })));
        }
        return undefined;
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffered += value;
        const lines = buffered.split('\n');
        buffered = done ? '' : lines.pop()!;
        const batch = lines.map(take).filter((row): row is unknown[] => row !== undefined);
        if (batch.length) handlers.onRows(batch);
        if (done) break;
      }
      return { kind: 'query', rows };
    } catch (error) {
      if (abort.signal.aborted) {
        // Closing the connection ends a push query; asking the server as well frees it at once.
        if (queryId) this.rest.json('/close-query', { method: 'POST', body: { queryId } }).catch(() => undefined);
        return { kind: 'query', rows };
      }
      throw error;
    }
  }
}
