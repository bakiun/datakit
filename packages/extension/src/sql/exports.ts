import { createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { quoteIdentifier, sqlParameter, type ExportFormat, type SqlSession } from '@datakit/core';
import { stringify } from 'csv-stringify/sync';
import { markdownTable } from 'markdown-table';
import writeXlsxFile from 'write-excel-file/node';
import { toText } from './values';

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  sql: 'sql',
  xlsx: 'xlsx',
  markdown: 'md',
};

export const EXPORT_FILTERS: Record<ExportFormat, Record<string, string[]>> = {
  csv: { CSV: ['csv'] },
  json: { JSON: ['json'] },
  sql: { SQL: ['sql'] },
  xlsx: { Excel: ['xlsx'] },
  markdown: { Markdown: ['md'] },
};

export interface ExportTarget {
  /** Table named in SQL INSERT exports. */
  table: string;
  /** Columns the server computes; SQL INSERT exports leave them out. */
  generated: ReadonlySet<string>;
  session: SqlSession;
}

/** Writes rows to a file as they arrive. CSV, JSON and SQL stream; Markdown and Excel need all rows at the end. */
export interface ExportWriter {
  start(columns: string[]): Promise<void>;
  write(row: unknown[]): Promise<void>;
  end(): Promise<void>;
  /** Stops early, e.g. when the export is cancelled; the partial file is closed. */
  abort(): Promise<void>;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'number' || value === null || value === undefined ? (value ?? null) : toText(value);
}

function markdownCell(value: unknown): string {
  const text = toText(value);
  return text === null ? 'NULL' : text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A file written line by line, waiting when the disk falls behind. */
class LineFile {
  private readonly stream: WriteStream;

  constructor(path: string) {
    this.stream = createWriteStream(path);
  }

  async write(text: string): Promise<void> {
    if (!this.stream.write(text)) await once(this.stream, 'drain');
  }

  async close(): Promise<void> {
    this.stream.end();
    await once(this.stream, 'close');
  }
}

export function openExport(format: ExportFormat, file: string, target: ExportTarget): ExportWriter {
  let columns: string[] = [];
  if (format === 'markdown' || format === 'xlsx') {
    const rows: unknown[][] = [];
    const done = async () => {
      if (format === 'markdown') {
        const out = new LineFile(file);
        await out.write(`${markdownTable([columns, ...rows.map((r) => r.map(markdownCell))])}\n`);
        await out.close();
      } else {
        const header = columns.map((c) => ({ value: c, fontWeight: 'bold' as const }));
        await writeXlsxFile([header, ...rows.map((r) => r.map((v) => (typeof v === 'number' ? v : toText(v))))]).toFile(file);
      }
    };
    return {
      start: async (c) => void (columns = c),
      write: async (row) => void rows.push(row),
      end: done,
      abort: done,
    };
  }

  const out = new LineFile(file);
  let first = true;
  let insert: { head: string; keep: number[] } | null = null;
  return {
    async start(c) {
      columns = c;
      if (format === 'csv') await out.write(stringify([columns]));
      else if (format === 'json') await out.write('[');
      else {
        const keep = columns.map((_, i) => i).filter((i) => !target.generated.has(columns[i]!));
        const quote = (name: string) => quoteIdentifier(name, target.session.dialect);
        insert = { head: `INSERT INTO ${quote(target.table)} (${keep.map((i) => quote(columns[i]!)).join(', ')}) VALUES`, keep };
      }
    },
    async write(row) {
      if (format === 'csv') await out.write(stringify([row.map((v) => toText(v) ?? '')]));
      else if (format === 'json') {
        const object = Object.fromEntries(columns.map((c, i) => [c, jsonValue(row[i])]));
        await out.write(`${first ? '\n' : ',\n'}  ${JSON.stringify(object)}`);
      } else {
        const { head, keep } = insert!;
        const values = keep.map((_, n) => sqlParameter(target.session.dialect, n + 1)).join(', ');
        const sql = target.session.format({ sql: `${head} (${values})`, params: keep.map((i) => row[i]) });
        await out.write(`${sql};\n`);
      }
      first = false;
    },
    async end() {
      if (format === 'json') await out.write(first ? ']\n' : '\n]\n');
      await out.close();
    },
    abort: () => out.close(),
  };
}

/** Writes the rows already in memory, e.g. the shown page. */
export async function writeExport(format: ExportFormat, file: string, target: ExportTarget, columns: string[], rows: unknown[][]): Promise<void> {
  const writer = openExport(format, file, target);
  await writer.start(columns);
  for (const row of rows) await writer.write(row);
  await writer.end();
}
