import { parseArgsStringToArgv } from 'string-argv';

/** Splits a command line into arguments; quotes group words, as in redis-cli. */
export function splitCommandLine(line: string): string[] {
  return parseArgsStringToArgv(line);
}

/** The key list query of the key browser: where SCAN starts and what it asks for. */
export interface ScanCommand {
  cursor: string;
  match: string;
  /** The COUNT hint; null for the data source's default. */
  count: number | null;
  /** The TYPE filter; null for all types. */
  type: string | null;
}

export type ScanParseResult = { ok: true; scan: ScanCommand; fromKeys: boolean } | { ok: false; error: string };

/**
 * Reads a SCAN command (`SCAN 0 MATCH user:* COUNT 500 TYPE hash`) or a KEYS command, which is turned into a SCAN
 * so a large database does not block the server. A lone pattern such as `user:*` is read as `SCAN 0 MATCH user:*`,
 * and a SCAN without a cursor starts at 0. Returns null for other commands.
 */
export function parseScanCommand(args: readonly string[]): ScanParseResult | null {
  const name = args[0]?.toUpperCase();
  // Command names never hold `*`, `?`, `[` or `:`; key patterns usually do.
  if (args.length === 1 && /[*?[:]/.test(args[0]!)) return { ok: true, scan: { cursor: '0', match: args[0]!, count: null, type: null }, fromKeys: false };
  if (name === 'KEYS') {
    if (args.length > 2) return { ok: false, error: 'KEYS takes one pattern; put a pattern with spaces in quotes, e.g. KEYS "user name:*".' };
    return { ok: true, scan: { cursor: '0', match: args[1] ?? '*', count: null, type: null }, fromKeys: true };
  }
  if (name !== 'SCAN') return null;
  const hasCursor = args[1] !== undefined && /^\d+$/.test(args[1]);
  const scan: ScanCommand = { cursor: hasCursor ? args[1]! : '0', match: '*', count: null, type: null };
  for (let i = hasCursor ? 2 : 1; i < args.length; i += 2) {
    const option = args[i]!.toUpperCase();
    const value = args[i + 1];
    if (value === undefined) return { ok: false, error: `${option} needs a value.` };
    if (option === 'MATCH') scan.match = value;
    else if (option === 'TYPE') scan.type = value.toLowerCase();
    else if (option === 'COUNT') {
      if (!/^[1-9]\d*$/.test(value)) return { ok: false, error: 'COUNT must be a whole number above 0.' };
      scan.count = Number(value);
    } else return { ok: false, error: `Unknown SCAN option “${args[i]}”. Use MATCH, COUNT or TYPE.` };
  }
  return { ok: true, scan, fromKeys: false };
}

/** Writes a SCAN command back, quoting a pattern with spaces or quotes. */
export function formatScanCommand(scan: ScanCommand): string {
  const quote = (value: string) => (value === '' || /[\s"']/.test(value) ? (value.includes('"') ? `'${value}'` : `"${value}"`) : value);
  const parts = ['SCAN', scan.cursor, 'MATCH', quote(scan.match)];
  if (scan.count !== null) parts.push('COUNT', String(scan.count));
  if (scan.type !== null) parts.push('TYPE', scan.type);
  return parts.join(' ');
}
