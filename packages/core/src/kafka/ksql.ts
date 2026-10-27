/** ksqlDB statements that only read, after any leading `--` comment lines; any other one changes the server. */
const KSQL_READS = /^\s*(?:--[^\n]*\n\s*)*(SELECT|SHOW|LIST|DESCRIBE|EXPLAIN|PRINT)\b/i;

/** Whether the statement may change the server, so a read-only data source refuses it and Production asks first. */
export function ksqlStatementWrites(statement: string): boolean {
  return !KSQL_READS.test(statement);
}
