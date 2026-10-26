import type { MongoBsonType, MongoDocument, MongoFieldPreview } from '@datakit/core';
import { parse, ParseMode } from '@mongodb-js/shell-bson-parser';
import { BSON, type Binary, type BSONSymbol, type Document, type Double, type Int32 } from 'mongodb';
import { toJSString } from 'mongodb-query-parser';

/**
 * Values in shell syntax. Documents are read with `promoteValues: false`, so every BSON number keeps its type; the
 * text printed for them parses back to the same types: Int32 prints as a plain number, a Double as a plain number
 * unless it would read back as an Int32 (`Double('5')`), and an Int64 as `NumberLong('…')`.
 */

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const PREVIEW_LENGTH = 200;
const LARGE_DOCUMENT = 1024 * 1024;
const LARGE_DOCUMENT_TEXT = 64 * 1024;

const isInt32 = (n: number) => Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX && !Object.is(n, -0);
const bsonTypeName = (value: object): string | undefined => (value as { _bsontype?: string })._bsontype;

/** A plain object: not an array, a date, a regular expression or a BSON value such as ObjectId. */
export function isDocument(value: unknown): value is Document {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp) && bsonTypeName(value) === undefined;
}

/** Replaces the number wrappers that print the same as plain numbers, so the text stays short. */
function forShell(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(forShell);
  if (typeof value !== 'object' || value === null || value instanceof Date || value instanceof RegExp) return value;
  switch (bsonTypeName(value)) {
    case undefined:
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, forShell(v)]));
    case 'Int32':
      return (value as Int32).value;
    case 'Double': {
      const n = (value as Double).value;
      return isInt32(n) ? value : n;
    }
    case 'BSONSymbol':
      // Symbols are deprecated; the shell reads them as strings too.
      return (value as BSONSymbol).value;
    default:
      return value;
  }
}

/** The value in shell syntax, indented by two spaces. */
export function shellText(value: unknown): string {
  return toJSString(forShell(value), 2) ?? 'undefined';
}

/** The value in shell syntax on one line, e.g. `{ customer: 1, created: -1 }`. */
export function shellLine(value: unknown): string {
  // Line breaks inside strings are escaped, so every line break is layout.
  return shellText(value).replace(/\n\s*/g, ' ');
}

/** One line when it is short, as mongosh prints values; indented otherwise. */
export function shellPrint(value: unknown, width = 72): string {
  const line = shellLine(value);
  return line.length <= width ? line : shellText(value);
}

export function cut(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

/** The BSON type name of a value read with `promoteValues: false`. */
export function bsonTypeOf(value: unknown): MongoBsonType {
  if (value === null) return 'Null';
  if (value === undefined) return 'Undefined';
  if (Array.isArray(value)) return 'Array';
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'number':
      return isInt32(value) ? 'Int32' : 'Double';
    case 'bigint':
      return 'Int64';
    case 'object':
      break;
    default:
      return 'Code';
  }
  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  switch (bsonTypeName(value)) {
    case 'ObjectId':
      return 'ObjectId';
    case 'Int32':
      return 'Int32';
    case 'Long':
      return 'Int64';
    case 'Double':
      return 'Double';
    case 'Decimal128':
      return 'Decimal128';
    case 'Binary':
      return (value as Binary).sub_type === 4 ? 'UUID' : 'Binary';
    case 'BSONRegExp':
      return 'RegExp';
    case 'Timestamp':
      return 'Timestamp';
    case 'MinKey':
      return 'MinKey';
    case 'MaxKey':
      return 'MaxKey';
    case 'Code':
      return 'Code';
    case 'BSONSymbol':
      return 'Symbol';
    case 'DBRef':
      return 'DBRef';
    default:
      return 'Object';
  }
}

/** The `_id` as canonical Extended JSON, which keeps its exact BSON type. */
export function idToText(id: unknown): string {
  return BSON.EJSON.stringify(id, { relaxed: false });
}

export function idFromText(id: string): unknown {
  try {
    return BSON.EJSON.parse(id, { relaxed: false });
  } catch (error) {
    throw new Error(`Not a document id: ${(error as Error).message}`);
  }
}

function fieldPreview(name: string, value: unknown): MongoFieldPreview {
  const text = shellLine(value);
  return { name, type: bsonTypeOf(value), preview: cut(text, PREVIEW_LENGTH), complete: text.length <= PREVIEW_LENGTH };
}

/** A document read with `promoteValues: false`, for the table and the editor. */
export function toMongoDocument(document: Document): MongoDocument {
  const size = BSON.calculateObjectSize(document);
  const truncated = size > LARGE_DOCUMENT;
  const text = shellText(document);
  const hasId = Object.hasOwn(document, '_id');
  return {
    id: hasId ? idToText(document._id) : null,
    idText: hasId ? shellLine(document._id) : null,
    text: truncated ? text.slice(0, LARGE_DOCUMENT_TEXT) : text,
    truncated,
    fields: Object.entries(document).map(([name, value]) => fieldPreview(name, value)),
    size,
  };
}

/**
 * Parser errors name a position in the input wrapped as `(\n…\n)` and repeat the input; this keeps the message and
 * gives the position in the text as typed.
 */
function parserMessage(error: unknown, text: string): string {
  let message = error instanceof Error ? error.message : String(error);
  const echo = ` in (\n${text}\n)`;
  if (message.endsWith(echo)) message = message.slice(0, -echo.length);
  const lines = text.split('\n').length;
  return message.replace(/ \((\d+):(\d+)\)$/, (_, line: string, column: string) => {
    const l = Number(line) - 1;
    if (l < 1 || l > lines) return ' at the end';
    return lines > 1 ? ` (line ${l}, column ${Number(column) + 1})` : ` (column ${Number(column) + 1})`;
  });
}

/**
 * Parses a text in shell syntax with one of the parsers of mongodb-query-parser or shell-bson-parser. Errors start
 * with `what`, e.g. `Filter: Unexpected token (column 6)`.
 */
export function parseWith(what: string, text: string, parser: (text: string) => unknown = parseValue): unknown {
  let value: unknown;
  try {
    value = parser(text);
  } catch (error) {
    throw new Error(`${what}: ${parserMessage(error, text)}`);
  }
  // The parsers return '' for code they refuse to run, such as variables or unknown functions.
  if (value === '' && !/^\s*(''|"")\s*$/.test(text) && text.trim() !== '') {
    throw new Error(`${what}: Only values can be used here, e.g. { status: "A", created: { $gte: ISODate("2024-01-01") } }; variables and functions other than ObjectId(), ISODate() and the like are not.`);
  }
  return value;
}

function parseValue(text: string): unknown {
  return parse(text, { mode: ParseMode.Loose, allowMethods: true });
}

/** A document in shell syntax; an empty text is `empty`. */
export function parseDocument(what: string, text: string, empty?: Document): Document {
  if (!text.trim() && empty) return empty;
  const value = parseWith(what, text);
  if (!isDocument(value)) throw new Error(`${what}: Give a document, e.g. { status: "A" }.`);
  return value;
}

/** An aggregation pipeline: an array of stages in shell syntax; an empty text is no stage. */
export function parsePipeline(what: string, text: string): Document[] {
  if (!text.trim()) return [];
  const value = parseWith(what, text);
  if (!Array.isArray(value) || !value.every(isDocument)) throw new Error(`${what}: Give an array of stages, e.g. [{ $match: { status: "A" } }].`);
  return value;
}

/** Stages that write their output to a collection. */
export function writingStage(stages: readonly unknown[]): string | null {
  for (const stage of stages) {
    if (!isDocument(stage)) continue;
    const name = Object.keys(stage)[0];
    if (name === '$out' || name === '$merge') return name;
  }
  return null;
}
