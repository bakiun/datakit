import { mysqlSplitterOptions, postgreSplitterOptions, splitQuery } from 'dbgate-query-splitter';
import type { SqlDialect } from './table';

export interface ScriptPart {
  text: string;
  /** Offsets of `text` in the script; the delimiter after it is not included. */
  from: number;
  to: number;
}

/**
 * Splits a script into statements, with where each statement sits in the script. Quotes and comments are honoured,
 * on MySQL also `DELIMITER`, on PostgreSQL dollar-quoted bodies such as `$$ … $$`.
 */
export function splitSqlScript(sql: string, dialect: SqlDialect): ScriptPart[] {
  const options = dialect === 'postgres' ? postgreSplitterOptions : mysqlSplitterOptions;
  const parts: ScriptPart[] = [];
  for (const item of splitQuery(sql, { ...options, returnRichInfo: true })) {
    if (typeof item === 'string' || !item.trimStart || !item.trimEnd) continue;
    const from = item.trimStart.position;
    const to = item.trimEnd.position;
    const text = sql.slice(from, to);
    if (text.trim()) parts.push({ text, from, to });
  }
  return parts;
}

/** Like `splitSqlScript`, the statements only. */
export function splitSqlStatements(sql: string, dialect: SqlDialect): string[] {
  return splitSqlScript(sql, dialect).map((s) => s.text);
}

/** Comments and whitespace before the first word of a statement. */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;

/** First keyword of a statement, upper-cased; `(` for a parenthesised query. */
export function leadingKeyword(statement: string): string {
  const rest = statement.replace(LEADING_NOISE, '');
  if (rest.startsWith('(')) return '(';
  return /^[A-Za-z_]+/.exec(rest)?.[0].toUpperCase() ?? '';
}

const MYSQL_READING = new Set(['SELECT', 'WITH', '(', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES', 'HELP', 'USE']);
/** PostgreSQL statements that only read; FETCH and MOVE read from a cursor that DECLARE opened. */
const POSTGRES_READING = new Set(['SELECT', 'WITH', '(', 'SHOW', 'EXPLAIN', 'TABLE', 'VALUES', 'DECLARE', 'FETCH', 'MOVE', 'CLOSE']);
/** Writes a PostgreSQL CTE or EXPLAIN ANALYZE can hold; REPLACE is left out, as `replace()` is a common function. */
const POSTGRES_WRITES = /\b(INSERT|UPDATE|DELETE|MERGE)\b/i;

/** Whether a statement may change data or settings; production data sources confirm these. */
export function changesData(statement: string, dialect: SqlDialect): boolean {
  const keyword = leadingKeyword(statement);
  if (dialect !== 'postgres') {
    // A CTE can lead into UPDATE or DELETE; a stray match only costs a confirmation.
    if (keyword === 'WITH') return /\b(UPDATE|DELETE|INSERT|REPLACE)\b/i.test(statement);
    return !MYSQL_READING.has(keyword);
  }
  switch (keyword) {
    // A CTE can hold INSERT, UPDATE or DELETE … RETURNING.
    case 'WITH':
      return POSTGRES_WRITES.test(statement);
    // SELECT … INTO creates a table.
    case 'SELECT':
      return /\bINTO\b/i.test(statement);
    // EXPLAIN ANALYZE runs the statement it explains.
    case 'EXPLAIN':
      return /\bANALY[SZ]E\b/i.test(statement) && (POSTGRES_WRITES.test(statement) || /\b(CREATE|EXECUTE)\b/i.test(statement));
    // COPY … TO STDOUT reads; COPY … FROM and COPY into a server file write.
    case 'COPY':
      return !/\bTO\s+STDOUT\b/i.test(statement);
    default:
      return !POSTGRES_READING.has(keyword);
  }
}

/** Queries whose ORDER BY and LIMIT the data view can rewrite for sorting and paging. */
export function isPageableQuery(statement: string, dialect: SqlDialect): boolean {
  const keyword = leadingKeyword(statement);
  if (keyword !== 'SELECT' && keyword !== 'WITH' && keyword !== '(') return false;
  // Running a page again must not write again, e.g. a CTE that deletes rows and returns them.
  return dialect !== 'postgres' || !changesData(statement, dialect);
}

const MYSQL_EXPLAINABLE = new Set(['SELECT', 'WITH', '(', 'TABLE', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE']);
const POSTGRES_EXPLAINABLE = new Set(['SELECT', 'WITH', '(', 'TABLE', 'VALUES', 'UPDATE', 'DELETE', 'INSERT', 'MERGE', 'EXECUTE']);

/** Statements EXPLAIN can describe without running them. */
export function isExplainable(statement: string, dialect: SqlDialect): boolean {
  return (dialect === 'postgres' ? POSTGRES_EXPLAINABLE : MYSQL_EXPLAINABLE).has(leadingKeyword(statement));
}
