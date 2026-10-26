import { quoteString } from '@datakit/core';

/**
 * Turns `information_schema.COLUMNS.COLUMN_DEFAULT` into SQL that can follow `DEFAULT`.
 * MySQL reports literals unquoted and marks expressions with DEFAULT_GENERATED; MariaDB quotes string
 * literals and leaves expressions unmarked.
 */

const TIME_FUNCTION = /^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i;
const NUMBER = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
const BIT = /^b'[01]*'$/i;

/** Expressions other than CURRENT_TIMESTAMP and the like must be in parentheses. */
function expression(value: string): string {
  return TIME_FUNCTION.test(value) || value.startsWith('(') ? value : `(${value})`;
}

export function defaultSql(
  raw: string | null,
  column: { nullable: boolean; numeric: boolean; extra: string },
  product: 'MySQL' | 'MariaDB',
): string | null {
  if (raw === null || (product === 'MariaDB' && raw === 'NULL')) return column.nullable ? 'NULL' : null;
  if (product === 'MariaDB') {
    if (raw.startsWith("'") || NUMBER.test(raw) || BIT.test(raw)) return raw;
    return expression(raw);
  }
  if (/DEFAULT_GENERATED/i.test(column.extra)) return expression(raw);
  if ((column.numeric && NUMBER.test(raw)) || BIT.test(raw)) return raw;
  return quoteString(raw);
}
