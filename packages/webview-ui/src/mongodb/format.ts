import type { MongoBsonType, MongoDocument } from '@datakit/core';

/** Formatting shared by the MongoDB collection screens: numbers, sizes, paging, query errors and type colors. */

export const num = (n: number): string => n.toLocaleString('en-US');

/** `1 document`, `40 documents`. */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${num(n)} ${n === 1 ? word : many}`;
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** `512 B`, `1.1 GB`, `742 MB`; `—` when the size is unknown. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`;
}

/** A duration in the largest unit it divides into: `90 d`, `12 h`, `30 min`, `45 s`. */
export function formatSeconds(seconds: number): string {
  if (seconds > 0 && seconds % 86_400 === 0) return `${num(seconds / 86_400)} d`;
  if (seconds > 0 && seconds % 3_600 === 0) return `${num(seconds / 3_600)} h`;
  if (seconds > 0 && seconds % 60 === 0) return `${num(seconds / 60)} min`;
  return `${num(seconds)} s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD`. */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `42%`, `<1%` for a small non-zero share, `100%`. */
export function percent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%';
  const p = (part / whole) * 100;
  if (p < 1) return '<1%';
  if (p > 99 && part < whole) return '>99%';
  return `${Math.round(p)}%`;
}

/** Documents per page the select offers. */
export const PAGE_SIZES: readonly number[] = [20, 50, 100, 500];

/** The page size to start with, from the data source's options, kept within what the select offers. */
export function startPageSize(fromOptions: number): number {
  const min = PAGE_SIZES[0]!;
  const max = PAGE_SIZES[PAGE_SIZES.length - 1]!;
  return Math.max(min, Math.min(max, Math.round(fromOptions) || min));
}

/** The select's sizes, with the starting size added when it is not one of them. */
export function pageSizeChoices(start: number): number[] {
  return [...new Set([...PAGE_SIZES, start])].sort((a, b) => a - b);
}

/** What the paging shows, e.g. `21–40 of 1,234`; `skip` is where the shown page starts among the matches. */
export function pageRange(skip: number, shown: number, count: number | null): string {
  const total = count === null ? 'many' : num(count);
  if (!shown) return count === null ? 'No documents' : `0 of ${total}`;
  return `${num(skip + 1)}–${num(skip + shown)} of ${total}`;
}

/** The index of the last page, or null when the count is not known. `baseSkip` is the Skip of the query. */
export function lastPageIndex(count: number | null, baseSkip: number, size: number): number | null {
  if (count === null) return null;
  return Math.max(0, Math.ceil((count - baseSkip) / size) - 1);
}

export type QueryField = 'filter' | 'projection' | 'sort' | 'collation' | 'skip';

/**
 * The field of the query bar an error names, so the field can be marked: messages start with it (`Filter: …`,
 * `Sort: …`) or say e.g. `invalid projection`.
 */
export function errorField(message: string): QueryField | null {
  const m = /^\s*(filter|projection|project|sort|collation|skip)\b/i.exec(message) ?? /\b(?:invalid|bad|in the|in)\s+(filter|projection|sort|collation|skip)\b/i.exec(message);
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  return word === 'project' ? 'projection' : (word as QueryField);
}

/** A Skip as typed: empty is 0; null when it is not a whole number. */
export function parseSkip(text: string): number | null {
  const t = text.replace(/[,_\s]/g, '');
  if (!t) return 0;
  return /^\d{1,15}$/.test(t) ? Number(t) : null;
}

/** The first `max` lines of a text and how many lines are left out. */
export function firstLines(text: string, max: number): { text: string; hidden: number } {
  let at = -1;
  for (let i = 0; i < max; i++) {
    at = text.indexOf('\n', at + 1);
    if (at < 0) return { text, hidden: 0 };
  }
  let hidden = 0;
  for (let i = at; i >= 0; i = text.indexOf('\n', i + 1)) hidden++;
  return { text: text.slice(0, at), hidden };
}

/** Documents as one array in shell syntax, for the JSON view and copying. */
export function documentsArray(documents: readonly MongoDocument[]): string {
  if (!documents.length) return '[]';
  return `[\n${documents.map((d) => d.text.replace(/^/gm, '  ')).join(',\n')}\n]`;
}

/** The key a document has in lists: its `_id`, or its place for documents without one (aggregation output). */
export const documentKey = (d: MongoDocument, index: number): string => d.id ?? `#${index}`;

/** Values that can be typed into a table cell; objects and arrays are edited in the document pane. */
export function isScalar(type: MongoBsonType): boolean {
  return type !== 'Object' && type !== 'Array';
}

/** Text color of a value of the type, as the code editor colors the same token. */
export function typeTextColor(type: MongoBsonType): string {
  switch (type) {
    case 'String':
    case 'Symbol':
      return 'var(--vscode-debugTokenExpression-string)';
    case 'Int32':
    case 'Int64':
    case 'Double':
    case 'Decimal128':
      return 'var(--vscode-debugTokenExpression-number)';
    case 'Boolean':
    case 'Null':
    case 'Undefined':
      return 'var(--vscode-debugTokenExpression-boolean)';
    case 'Object':
    case 'Array':
      return 'var(--vscode-foreground)';
    default:
      return 'var(--vscode-symbolIcon-typeParameterForeground)';
  }
}

/**
 * The color of a type in the schema bars and legends; every type keeps its color everywhere. Theme chart colors come
 * first, with token colors as fallbacks for themes that lack them.
 */
export function typeChartColor(type: MongoBsonType): string {
  switch (type) {
    case 'String':
      return 'var(--vscode-charts-green, var(--vscode-testing-iconPassed))';
    case 'Int32':
      return 'var(--vscode-charts-blue, var(--vscode-textLink-foreground))';
    case 'Int64':
      return 'var(--vscode-terminal-ansiCyan, var(--vscode-symbolIcon-typeParameterForeground))';
    case 'Double':
      return 'var(--vscode-charts-purple, var(--vscode-debugTokenExpression-boolean))';
    case 'Decimal128':
      return 'var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground))';
    case 'Date':
    case 'Timestamp':
      return 'var(--vscode-charts-orange, var(--vscode-editorWarning-foreground))';
    case 'ObjectId':
      return 'var(--vscode-symbolIcon-typeParameterForeground, var(--vscode-charts-blue))';
    case 'Boolean':
      return 'var(--vscode-debugTokenExpression-boolean, var(--vscode-charts-blue))';
    case 'Object':
      return 'var(--vscode-symbolIcon-variableForeground, var(--vscode-charts-blue))';
    case 'Array':
      return 'var(--vscode-charts-red, var(--vscode-debugTokenExpression-string))';
    case 'Binary':
    case 'UUID':
      return 'var(--vscode-terminal-ansiMagenta, var(--vscode-charts-purple, var(--vscode-debugTokenExpression-boolean)))';
    default:
      return 'var(--vscode-descriptionForeground)';
  }
}

/** A schema path split into the part before its last step and the last step, e.g. `items[].` and `sku`. */
export function splitPath(path: string): { parent: string; leaf: string; depth: number } {
  const at = path.lastIndexOf('.');
  const depth = (path.match(/\./g) ?? []).length;
  return at < 0 ? { parent: '', leaf: path, depth } : { parent: path.slice(0, at + 1), leaf: path.slice(at + 1), depth };
}

/** The type most values of a column have on the page, or `mixed`. */
export function columnType(types: readonly MongoBsonType[]): string {
  const known = types.filter((t) => t !== 'Null');
  if (!known.length) return types.length ? 'Null' : '';
  return known.every((t) => t === known[0]) ? known[0]! : 'mixed';
}

/** A one-line version of a shell text for chips and summaries, cut to `max` characters. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The stages an aggregation pipeline writes with, which a rerun after a write must not repeat on its own. */
export const writesStage = (pipeline: string): boolean => /\$(?:out|merge)\b/.test(pipeline);
