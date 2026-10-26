import type { ServerVersion } from '@datakit/core';

/** Parses `server_version`, e.g. `17.6 (Debian 17.6-1.pgdg120+1)` or `16.4`. */
export function parsePostgresVersion(raw: string): ServerVersion {
  const version = /^\d+(?:\.\d+){0,2}/.exec(raw.trim())?.[0] ?? raw.trim();
  return { product: 'PostgreSQL', version };
}
