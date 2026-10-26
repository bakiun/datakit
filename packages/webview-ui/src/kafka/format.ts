import type { ConnectorState, KafkaGroupSummary, KafkaMessage, KafkaPayload } from '@datakit/core';

/** Formatting shared by the Kafka workspace screens: numbers, sizes, local times, payloads and states. */

export const num = (n: number): string => n.toLocaleString('en-US');

/** An int64 offset with thousands separators, e.g. `200,738`. */
export const offsetText = (offset: string): string => offset.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `1 message`, `40 messages`. */
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

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local `YYYY-MM-DD HH:MM:SS`. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatClock(ms)}`;
}

/** Local `HH:MM:SS`. */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `02:14` or `1:02:14` for a running time. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const rest = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return h ? `${h}:${rest}` : rest;
}

/** A typed value: null when the field is empty, `error` when it cannot be used. */
export interface Parsed<T> {
  value: T | null;
  error: string | null;
}

/**
 * `YYYY-MM-DD HH:MM[:SS]` (or only the date) in local time. For the inclusive end of a range (`end`), what is left out
 * reaches to its end: `2026-10-24 12:30` covers 12:30:59.999.
 */
export function parseLocalTime(text: string, end = false): Parsed<number> {
  const t = text.trim();
  if (!t) return { value: null, error: null };
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  const invalid = { value: null, error: 'Times are YYYY-MM-DD HH:MM[:SS].' };
  if (!m) return invalid;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] === undefined ? (end ? 23 : 0) : Number(m[4]);
  const mi = m[5] === undefined ? (end ? 59 : 0) : Number(m[5]);
  const s = m[6] === undefined ? (end ? 59 : 0) : Number(m[6]);
  const date = new Date(y, mo - 1, d, h, mi, s, end ? 999 : 0);
  const same = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi && date.getSeconds() === s;
  return same ? { value: date.getTime(), error: null } : invalid;
}

/** An int64 offset as a decimal string; commas, spaces and underscores are ignored. */
export function parseOffset(text: string): Parsed<string> {
  const t = text.replace(/[,_\s]/g, '');
  if (!t) return { value: null, error: null };
  if (!/^\d+$/.test(t) || t.length > 19) return { value: null, error: 'Offsets are whole numbers.' };
  return { value: BigInt(t).toString(), error: null };
}

/** A partition number below `partitions`. */
export function parsePartition(text: string, partitions: number): Parsed<number> {
  const t = text.trim();
  if (!t) return { value: null, error: null };
  const n = Number(t);
  if (!/^\d+$/.test(t) || n >= partitions) return { value: null, error: `Partitions are 0 to ${partitions - 1}.` };
  return { value: n, error: null };
}

/** The payload as text; a schema payload decoded with its schema shows the decoded JSON. */
export function payloadText(payload: KafkaPayload | null): string | null {
  if (!payload) return null;
  return payload.decoded ?? payload.text;
}

/** One line for a table cell, cut short so large payloads keep the DOM small. */
export function payloadPreview(payload: KafkaPayload | null, max = 400): { text: string; muted: boolean } {
  if (!payload) return { text: 'null', muted: true };
  if (payload.decoded !== null) return { text: compactJson(payload.decoded).slice(0, max), muted: false };
  if (payload.binary) return { text: `0x${payload.text.slice(0, max)}`, muted: true };
  if (payload.text === '') return { text: '(empty)', muted: true };
  return { text: payload.text.slice(0, max).replace(/\s*\n\s*/g, ' '), muted: false };
}

/** JSON text indented by two spaces; null when the text is not a JSON object or array. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text.replace(/\s*\n\s*/g, ' ');
  }
}

/** The bytes of a payload: binary payloads come as hex pairs, others as UTF-8 text. */
export function payloadBytes(payload: KafkaPayload): Uint8Array {
  if (!payload.binary) return new TextEncoder().encode(payload.text);
  const bytes = new Uint8Array(Math.floor(payload.text.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(payload.text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export interface HexRow {
  offset: string;
  hex: string;
  ascii: string;
}

/** A hex dump, 16 bytes per row, of the first `maxBytes` bytes. */
export function hexRows(bytes: Uint8Array, maxBytes = 4096): HexRow[] {
  const rows: HexRow[] = [];
  const end = Math.min(bytes.length, maxBytes);
  for (let at = 0; at < end; at += 16) {
    const row = Array.from(bytes.subarray(at, Math.min(at + 16, end)));
    rows.push({
      offset: at.toString(16).padStart(4, '0'),
      hex: row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' '),
      ascii: row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
    });
  }
  return rows;
}

/** Identifies a message within its topic. */
export const messageId = (m: { partition: number; offset: string }): string => `${m.partition}:${m.offset}`;

/** A message as one JSON line, for Copy all. Decoded schema values are written as JSON, other payloads as text. */
export function messageJson(m: KafkaMessage): string {
  const payload = (p: KafkaPayload | null): unknown => {
    if (!p) return null;
    if (p.decoded !== null) {
      try {
        return JSON.parse(p.decoded);
      } catch {
        return p.decoded;
      }
    }
    return p.text;
  };
  return JSON.stringify({
    partition: m.partition,
    offset: m.offset,
    timestamp: new Date(m.timestamp).toISOString(),
    key: payload(m.key),
    value: payload(m.value),
    headers: m.headers,
  });
}

/** Lag summed over the group's topics; null when no lag could be read. */
export function totalLag(group: KafkaGroupSummary): number | null {
  const lags = Object.values(group.lagByTopic);
  if (lags.length && lags.every((l) => l === null)) return null;
  return lags.reduce<number>((n, l) => n + (l ?? 0), 0);
}

export const lagText = (lag: number | null): string => (lag === null ? '—' : num(lag));

/** Colors of chips and values; each tone maps to a theme color in kafka.css. */
export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'muted';

/** A consumer group state as the chip shows it; the rebalancing states share one label. */
export function groupState(state: string): { label: string; tone: Tone } {
  switch (state) {
    case 'Stable':
      return { label: 'Stable', tone: 'ok' };
    case 'Empty':
      return { label: 'Empty', tone: 'muted' };
    case 'Dead':
      return { label: 'Dead', tone: 'error' };
    case 'PreparingRebalance':
    case 'CompletingRebalance':
    case 'Assigning':
    case 'Reconciling':
      return { label: 'Rebalancing', tone: 'warn' };
    default:
      return { label: state || 'Unknown', tone: 'muted' };
  }
}

export function connectorTone(state: ConnectorState): Tone {
  switch (state) {
    case 'RUNNING':
      return 'ok';
    case 'FAILED':
      return 'error';
    case 'PAUSED':
    case 'STOPPED':
      return 'warn';
    default:
      return 'info';
  }
}

/** `S3SinkConnector` of `io.confluent.connect.s3.S3SinkConnector`. */
export const shortClass = (className: string): string => className.slice(className.lastIndexOf('.') + 1);

/** The first line of a stack trace. */
export const firstLine = (trace: string): string => trace.split(/\r?\n/, 1)[0]!.trim();

/** A plain-text table with padded columns, for the clipboard. */
export function textTable(head: string[], rows: string[][], right: readonly boolean[] = []): string {
  const widths = head.map((h, i) => rows.reduce((w, r) => Math.max(w, (r[i] ?? '').length), h.length));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (right[i] ? c.padStart(widths[i]!) : c.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** A JSON object whose values are all strings, as Kafka Connect configs are. */
export function stringMap(text: string): Parsed<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: null, error: 'Not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { value: null, error: 'The config is a JSON object.' };
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return { value: null, error: `“${key}” must be a string, e.g. "${String(value)}".` };
  }
  return { value: parsed as Record<string, string>, error: null };
}
