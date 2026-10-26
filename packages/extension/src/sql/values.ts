import type { CellValue } from '@datakit/core';

/** Bytes of a binary value sent to the grid; the full value stays in the extension. */
const BINARY_PREVIEW_BYTES = 64;

/** Converts a driver value into what the grid shows. */
export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (Buffer.isBuffer(value)) return { hex: value.subarray(0, BINARY_PREVIEW_BYTES).toString('hex'), length: value.length };
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** A driver value as plain text for exports: binary values become `0x…` hex. */
export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
