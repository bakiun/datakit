import type { SqlStatement } from '@datakit/core';
import pg, { type CustomTypesConfig } from 'pg';

/** Type oids whose text the session turns into JavaScript values. */
const BOOL = 16;
const BYTEA = 17;
const INT2 = 21;
const INT4 = 23;
const OID = 26;
const FLOAT4 = 700;
const FLOAT8 = 701;

const asText = (value: string) => value;
const asNumber = (value: string) => Number(value);
/** Floats as numbers; `NaN` and `Infinity` stay text, which JSON and SQL can carry. */
const asFloat = (value: string) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
};

/**
 * Parsers for the values of user statements: show them as the server writes them, so nothing is rounded or shifted.
 * `numeric`, `int8`, dates and times, JSON, arrays, intervals, `uuid` and `inet` stay text; small integers and floats
 * become numbers, booleans booleans and `bytea` a Buffer.
 */
export const TEXT_TYPES = {
  getTypeParser(oid: number, format?: string) {
    if (format === 'binary') return pg.types.getTypeParser(oid, 'binary');
    switch (oid) {
      case BOOL:
        return (value: string) => value === 't';
      case BYTEA:
        return pg.types.getTypeParser(BYTEA, 'text');
      case INT2:
      case INT4:
      case OID:
        return asNumber;
      case FLOAT4:
      case FLOAT8:
        return asFloat;
      default:
        return asText;
    }
  },
} as unknown as CustomTypesConfig;

/** A value as a SQL literal, for previews and SQL exports. */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Buffer.isBuffer(value)) return `decode('${value.toString('hex')}', 'hex')`;
  if (value instanceof Date) return pg.escapeLiteral(value.toISOString());
  return pg.escapeLiteral(typeof value === 'object' ? JSON.stringify(value) : String(value));
}

/**
 * Writes the parameters of a statement built by core (`$1`, `$2`…) into its text. Quoted identifiers and string
 * literals are passed over, so a `$1` inside them stays as it is.
 */
export function formatStatement(statement: SqlStatement): string {
  return statement.sql.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|\$(\d+)/g, (match: string, index: string | undefined) =>
    index === undefined ? match : literal(statement.params[Number(index) - 1]),
  );
}
