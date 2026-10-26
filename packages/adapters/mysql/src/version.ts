import type { ServerVersion } from '@datakit/core';

/** Parses `SELECT VERSION()`, e.g. `8.0.36` or `10.11.6-MariaDB-1:10.11.6+maria~ubu2204`. */
export function parseMysqlVersion(raw: string): ServerVersion {
  const product = /mariadb/i.test(raw) ? 'MariaDB' : 'MySQL';
  // Older MariaDB servers prefix the version with `5.5.5-` for client compatibility.
  const text = raw.replace(/^5\.5\.5-/, '');
  const version = /^\d+(?:\.\d+){0,2}/.exec(text)?.[0] ?? text;
  return { product, version };
}
