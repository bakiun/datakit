import { MariaSQL, MySQL, PostgreSQL, type SQLDialect } from '@codemirror/lang-sql';
import { quoteIdentifier, type SortKey, type SqlDialect } from '@datakit/core';
import type { SyntaxNode } from '@lezer/common';

/**
 * Reads and rewrites the ORDER BY and LIMIT of a query so the grid's sorting and paging show up in the script.
 * The query is parsed with the editor's SQL grammar; only the clauses are replaced, the rest of the text is kept.
 */

/** The editor's grammar for each dialect. */
export const GRAMMARS: Record<SqlDialect, SQLDialect> = { mysql: MySQL, mariadb: MariaSQL, postgres: PostgreSQL };

export interface Paging {
  /** Null when the ORDER BY holds more than plain column names. */
  sort: SortKey[] | null;
  /** Null when the query has no LIMIT. */
  limit: number | null;
  offset: number;
}

interface Token {
  name: string;
  from: number;
  to: number;
  text: string;
}

interface Range {
  from: number;
  to: number;
}

interface Clauses {
  /** The query's own tokens, outside parentheses. */
  tokens: Token[];
  orderBy: Range | null;
  limit: (Range & { values: number[]; offsetKeyword: boolean }) | null;
  /** PostgreSQL: an OFFSET of its own, before or without LIMIT. */
  offset: (Range & { value: number }) | null;
  /** Where the query text ends, before trailing comments. */
  end: number;
}

/** Clauses that may follow ORDER BY and LIMIT; ORDER BY and LIMIT are inserted before them. */
const TAIL_KEYWORDS = new Set(['FOR', 'LOCK', 'INTO', 'PROCEDURE']);

function topTokens(text: string, dialect: SqlDialect): Token[] {
  const statement: SyntaxNode | null = GRAMMARS[dialect].language.parser.parse(text).topNode.getChild('Statement');
  const tokens: Token[] = [];
  for (let child = statement?.firstChild ?? null; child; child = child.nextSibling) {
    if (child.name === 'LineComment' || child.name === 'BlockComment' || child.name === ';') continue;
    tokens.push({ name: child.name, from: child.from, to: child.to, text: text.slice(child.from, child.to) });
  }
  return tokens;
}

function isKeyword(token: Token | undefined, word: string): boolean {
  return token?.name === 'Keyword' && token.text.toUpperCase() === word;
}

function analyse(text: string, dialect: SqlDialect): Clauses {
  const tokens = topTokens(text, dialect);
  const postgres = dialect === 'postgres';
  let orderBy: Clauses['orderBy'] = null;
  let limit: Clauses['limit'] = null;
  let offset: Clauses['offset'] = null;
  const endsClause = (t: Token) => isKeyword(t, 'LIMIT') || (postgres && isKeyword(t, 'OFFSET')) || (t.name === 'Keyword' && TAIL_KEYWORDS.has(t.text.toUpperCase()));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isKeyword(token, 'ORDER') && isKeyword(tokens[i + 1], 'BY')) {
      let j = i + 2;
      while (j < tokens.length && !endsClause(tokens[j]!)) j++;
      orderBy = { from: token.from, to: tokens[j - 1]!.to };
      i = j - 1;
    } else if (isKeyword(token, 'LIMIT')) {
      const values: number[] = [];
      let j = i + 1;
      let offsetKeyword = false;
      while (j < tokens.length) {
        const t = tokens[j]!;
        if (t.name === 'Number') values.push(Number(t.text));
        else if (isKeyword(t, 'OFFSET')) offsetKeyword = true;
        // PostgreSQL's LIMIT ALL is no limit.
        else if (!(t.name === 'Punctuation' && t.text === ',') && !(postgres && isKeyword(t, 'ALL'))) break;
        j++;
      }
      limit = { from: token.from, to: tokens[j - 1]!.to, values, offsetKeyword };
      i = j - 1;
    } else if (postgres && isKeyword(token, 'OFFSET') && tokens[i + 1]?.name === 'Number') {
      const rows = isKeyword(tokens[i + 2], 'ROWS') || isKeyword(tokens[i + 2], 'ROW') ? 1 : 0;
      offset = { from: token.from, to: tokens[i + 1 + rows]!.to, value: Number(tokens[i + 1]!.text) };
      i += 1 + rows;
    }
  }
  return { tokens, orderBy, limit, offset, end: tokens.at(-1)?.to ?? text.trimEnd().length };
}

const unquote = (name: string) => {
  if (name.startsWith('`') && name.endsWith('`')) return name.slice(1, -1).replace(/``/g, '`');
  if (name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1).replace(/""/g, '"');
  return name;
};

/** The PostgreSQL grammar reads many plain column names, such as `id`, as keywords. */
const SORT_WORDS = new Set(['ASC', 'DESC', 'NULLS', 'FIRST', 'LAST', 'USING']);
const isPlainName = (token: Token) => token.name === 'Keyword' && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(token.text) && !SORT_WORDS.has(token.text.toUpperCase());

function readSort(text: string, clauses: Clauses, dialect: SqlDialect): SortKey[] | null {
  if (!clauses.orderBy) return [];
  const inner = clauses.tokens.filter((t) => t.from > clauses.orderBy!.from && t.to <= clauses.orderBy!.to).slice(1);
  const items: Token[][] = [[]];
  for (const t of inner) {
    if (t.name === 'Punctuation' && t.text === ',') items.push([]);
    else items.at(-1)!.push(t);
  }
  const keys: SortKey[] = [];
  for (const item of items) {
    const [name, direction, ...rest] = item;
    const isName = ['Identifier', 'QuotedIdentifier', 'CompositeIdentifier'].includes(name?.name ?? '') || (dialect === 'postgres' && !!name && isPlainName(name));
    if (!name || rest.length || !isName) return null;
    if (direction && !isKeyword(direction, 'ASC') && !isKeyword(direction, 'DESC')) return null;
    const column = unquote(text.slice(name.from, name.to).split('.').at(-1)!);
    keys.push({ column, direction: isKeyword(direction, 'DESC') ? 'desc' : 'asc' });
  }
  return keys;
}

export function readPaging(text: string, dialect: SqlDialect): Paging {
  const clauses = analyse(text, dialect);
  const values = clauses.limit?.values ?? [];
  // LIMIT n · LIMIT n OFFSET m · LIMIT m, n · PostgreSQL: OFFSET m LIMIT n
  const [limit, offset] =
    values.length === 0 ? [null, 0] : values.length === 1 ? [values[0]!, 0] : clauses.limit!.offsetKeyword ? [values[0]!, values[1]!] : [values[1]!, values[0]!];
  return { sort: readSort(text, clauses, dialect), limit, offset: clauses.offset?.value ?? offset };
}

/** Rewrites the clauses named in `change`; the others stay as they are. */
export function applyPaging(text: string, dialect: SqlDialect, change: { sort?: SortKey[]; limit?: number; offset?: number }): string {
  let result = text;
  if (change.sort) result = replaceOrderBy(result, dialect, change.sort);
  if (change.limit !== undefined || change.offset !== undefined) {
    const current = readPaging(result, dialect);
    result = replaceLimit(result, dialect, change.limit ?? current.limit ?? 100, change.offset ?? current.offset);
  }
  return result;
}

function splice(text: string, from: number, to: number, insert: string): string {
  return text.slice(0, from) + insert + text.slice(to);
}

/** Removes a clause together with the whitespace in front of it. */
function cut(text: string, range: Range): string {
  return splice(text, text.slice(0, range.from).trimEnd().length, range.to, '');
}

/** Where a missing clause goes: before FOR UPDATE and the like, else at the end of the query. */
function insertionPoint(text: string, clauses: Clauses, after: number): { at: number; wrap: (clause: string) => string } {
  const separator = text.includes('\n') ? '\n' : ' ';
  const tail = clauses.tokens.find((t) => t.from >= after && t.name === 'Keyword' && TAIL_KEYWORDS.has(t.text.toUpperCase()));
  return tail
    ? { at: tail.from, wrap: (clause) => `${clause}${separator}` }
    : { at: clauses.end, wrap: (clause) => `${separator}${clause}` };
}

function replaceOrderBy(text: string, dialect: SqlDialect, sort: SortKey[]): string {
  const clauses = analyse(text, dialect);
  const order = sort.length ? `ORDER BY ${sort.map((k) => `${quoteIdentifier(k.column, dialect)} ${k.direction.toUpperCase()}`).join(', ')}` : '';
  if (clauses.orderBy) {
    // Removing the clause takes the whitespace in front of it along.
    const from = order ? clauses.orderBy.from : text.slice(0, clauses.orderBy.from).trimEnd().length;
    return splice(text, from, clauses.orderBy.to, order);
  }
  if (!order) return text;
  const first = [clauses.limit, clauses.offset].filter((r) => r !== null).sort((a, b) => a.from - b.from)[0];
  if (first) return splice(text, first.from, first.from, `${order}${text.includes('\n') ? '\n' : ' '}`);
  const { at, wrap } = insertionPoint(text, clauses, 0);
  return splice(text, at, at, wrap(order));
}

function replaceLimit(text: string, dialect: SqlDialect, limit: number, offset: number): string {
  let clauses = analyse(text, dialect);
  let result = text;
  // A PostgreSQL OFFSET of its own joins the LIMIT clause.
  if (clauses.offset) {
    result = cut(result, clauses.offset);
    clauses = analyse(result, dialect);
  }
  const clause = `LIMIT ${limit} OFFSET ${offset}`;
  if (clauses.limit) return splice(result, clauses.limit.from, clauses.limit.to, clause);
  const { at, wrap } = insertionPoint(result, clauses, clauses.orderBy?.to ?? 0);
  return splice(result, at, at, wrap(clause));
}

/** The query without its ORDER BY and LIMIT, for counting all of its rows. */
export function unpaged(text: string, dialect: SqlDialect): string {
  const clauses = analyse(text, dialect);
  let result = text.slice(0, clauses.end);
  for (const range of [clauses.limit, clauses.offset, clauses.orderBy].filter((r) => r !== null).sort((a, b) => b.from - a.from)) {
    result = result.slice(0, range.from) + result.slice(range.to);
  }
  return result.trim();
}

/** The query without its LIMIT and OFFSET, keeping ORDER BY: every row, in the shown order. */
export function withoutLimit(text: string, dialect: SqlDialect): string {
  const clauses = analyse(text, dialect);
  let result = text.slice(0, clauses.end);
  for (const range of [clauses.limit, clauses.offset].filter((r) => r !== null).sort((a, b) => b.from - a.from)) {
    result = result.slice(0, range.from) + result.slice(range.to);
  }
  return result.trim();
}
