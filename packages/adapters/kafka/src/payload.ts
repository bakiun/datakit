import { isUtf8 } from 'node:buffer';
import type { KafkaPayload } from '@datakit/core';

const lenient = new TextDecoder('utf-8', { ignoreBOM: true });

/** Message pages show this many bytes of a key or value; `readAll` keeps them whole. */
export const PAGE_PAYLOAD_BYTES = 64 * 1024;

/** The schema id of a payload in the Schema Registry wire format: a 0 byte, then the id as a 4-byte integer. */
export function wireSchemaId(bytes: Buffer): number | null {
  if (bytes.length < 5 || bytes[0] !== 0) return null;
  const id = bytes.readInt32BE(1);
  // Ids start at 1; a zero id is more likely a small number, e.g. an int64 value.
  return id > 0 ? id : null;
}

/** Bytes as UTF-8 text when they are valid, as hex otherwise; cut to `maxBytes` when set. */
export function toPayload(bytes: Buffer, maxBytes: number | null, decoded: string | null): KafkaPayload {
  const binary = !isUtf8(bytes);
  const cut = maxBytes !== null && bytes.length > maxBytes;
  // A cut payload may end inside a character, so the decoder must not refuse it.
  const shown = cut ? bytes.subarray(0, maxBytes) : bytes;
  const decodedCut = cut && decoded !== null && decoded.length > maxBytes!;
  return {
    text: binary ? shown.toString('hex') : lenient.decode(shown),
    binary,
    size: bytes.length,
    truncated: cut || decodedCut,
    schemaId: wireSchemaId(bytes),
    decoded: decodedCut ? decoded!.slice(0, maxBytes!) : decoded,
  };
}

/** A header value as text; bytes that are not UTF-8 are written as `\x..`. */
export function headerText(bytes: Buffer | null): string | null {
  if (bytes === null) return null;
  if (isUtf8(bytes)) return lenient.decode(bytes);
  let text = '';
  for (const byte of bytes) text += byte >= 0x20 && byte < 0x7f && byte !== 0x5c ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`;
  return text;
}

export function headerKey(bytes: Buffer | null): string {
  return bytes === null ? '' : lenient.decode(bytes);
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** A whole number as an 8-byte big-endian signed integer, as Kafka's LongSerializer writes it. */
export function encodeInt64(text: string): Buffer {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`“${text}” is not a whole number; Int64 values must be.`);
  const value = BigInt(trimmed);
  if (value < INT64_MIN || value > INT64_MAX) throw new Error(`${trimmed} does not fit in 64 bits.`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(value);
  return bytes;
}

/** Prefixes encoded bytes with the Schema Registry wire format header. */
export function withSchemaId(id: number, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeInt32BE(id, 1);
  return Buffer.concat([header, body]);
}

/** What the bytes look like when no schema says: `JSON` for an object or array, `String` or `Binary`. */
export function plainFormat(bytes: Buffer): 'JSON' | 'String' | 'Binary' {
  if (!isUtf8(bytes)) return 'Binary';
  try {
    const parsed: unknown = JSON.parse(lenient.decode(bytes));
    if (parsed !== null && typeof parsed === 'object') return 'JSON';
  } catch {
    // Not JSON.
  }
  return 'String';
}
