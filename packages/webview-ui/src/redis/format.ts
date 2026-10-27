import { redisTextLabel, type RedisText } from '@datakit/core';

/** Badge text and color of a key type; module types get a short name. */
export function typeBadge(type: string): { label: string; color: string } {
  const known: Record<string, { label: string; color: string }> = {
    hash: { label: 'HASH', color: 'var(--vscode-charts-blue)' },
    string: { label: 'STR', color: 'var(--vscode-charts-green)' },
    list: { label: 'LIST', color: 'var(--vscode-charts-orange)' },
    zset: { label: 'ZSET', color: 'var(--vscode-charts-purple)' },
    set: { label: 'SET', color: 'var(--vscode-terminal-ansiCyan)' },
    stream: { label: 'STREAM', color: 'var(--vscode-charts-yellow)' },
    'ReJSON-RL': { label: 'JSON', color: 'var(--vscode-charts-red)' },
    'TSDB-TYPE': { label: 'TS', color: 'var(--vscode-charts-red)' },
  };
  return known[type] ?? { label: type.replace(/[^A-Za-z]/g, '').slice(0, 6).toUpperCase() || '?', color: 'var(--vscode-descriptionForeground)' };
}

/** `38s`, `29m`, `5h`, `2d`; `—` when the key does not expire. */
export function shortTtl(ttl: number | null): string {
  if (ttl === null) return '—';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * A typed TTL in seconds: `90`, `90s`, `30m`, `2h`, `1d` or `1h 30m`; null when empty (no expiry), NaN when it
 * cannot be read.
 */
export function parseTtl(text: string): number | null {
  const typed = text.trim().toLowerCase().replace(/,/g, '');
  if (typed === '') return null;
  if (/^\d+$/.test(typed)) return Number(typed);
  const parts = [...typed.matchAll(/(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== typed) return Number.NaN;
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * TTL_UNITS[unit![0]!]!, 0);
}

export function longTtl(ttl: number | null): string {
  return ttl === null ? 'no expiry' : `${ttl.toLocaleString('en-US')} s`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const textOf = redisTextLabel;

export const isBinary = (text: RedisText): text is { hex: string } => typeof text !== 'string';

/** A stable string id of a key for lists and comparisons. */
export const keyId = (key: RedisText): string => (typeof key === 'string' ? `s:${key}` : `x:${key.hex}`);

/** What a value looks like, and its JSON when it is an object or array. */
export function describeValue(value: RedisText): { kind: string; json: unknown } {
  if (isBinary(value)) return { kind: `Binary · ${value.hex.length / 2} bytes`, json: undefined };
  const text = value.trim();
  if (/^[[{]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      const kind = Array.isArray(parsed) ? `Array · ${parsed.length} items` : `JSON object · ${Object.keys(parsed as object).length} keys`;
      return { kind, json: parsed };
    } catch {
      return { kind: 'Text · not valid JSON', json: undefined };
    }
  }
  if (text !== '' && !Number.isNaN(Number(text))) return { kind: 'Number', json: undefined };
  return { kind: `String · ${value.length} chars`, json: undefined };
}
