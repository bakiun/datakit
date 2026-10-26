import type { MongoBsonType, MongoFieldStats, MongoSchema } from '@datakit/core';
import type { Document } from 'mongodb';
import { bsonTypeOf, cut, isDocument, shellLine } from './values';

/**
 * Fields of a sample of documents: nested documents as `a.b`, array elements as `items[]` and `items[].sku`. Counts are
 * documents: an array with two strings counts its document once for `items[]` and once for String.
 */

const EXAMPLES = 3;
const EXAMPLE_LENGTH = 60;
const MAX_DEPTH = 20;
const MAX_FIELDS = 2000;

interface FieldNode {
  path: string;
  count: number;
  types: Map<MongoBsonType, number>;
  examples: Set<string>;
  children: Map<string, FieldNode>;
  /** The number of the document that last counted the field, and each type. */
  seenIn: number;
  typeSeenIn: Map<MongoBsonType, number>;
}

class SchemaBuilder {
  readonly root = new Map<string, FieldNode>();
  private fields = 0;
  private document = 0;

  add(document: Document): void {
    this.document++;
    this.walk(this.root, '', document, 0);
  }

  private walk(level: Map<string, FieldNode>, prefix: string, document: Document, depth: number): void {
    for (const [key, value] of Object.entries(document)) this.value(level, prefix ? `${prefix}.${key}` : key, key, value, depth);
  }

  private value(level: Map<string, FieldNode>, path: string, key: string, value: unknown, depth: number): void {
    const node = this.node(level, path, key);
    if (!node) return;
    if (node.seenIn !== this.document) {
      node.seenIn = this.document;
      node.count++;
    }
    const type = bsonTypeOf(value);
    if (node.typeSeenIn.get(type) !== this.document) {
      node.typeSeenIn.set(type, this.document);
      node.types.set(type, (node.types.get(type) ?? 0) + 1);
    }
    if (type !== 'Object' && type !== 'Array' && node.examples.size < EXAMPLES) node.examples.add(cut(shellLine(value), EXAMPLE_LENGTH));
    if (depth >= MAX_DEPTH) return;
    if (isDocument(value)) this.walk(node.children, path, value, depth + 1);
    else if (Array.isArray(value)) for (const element of value) this.value(node.children, `${path}[]`, '[]', element, depth + 1);
  }

  private node(level: Map<string, FieldNode>, path: string, key: string): FieldNode | undefined {
    let node = level.get(key);
    if (!node) {
      // Documents with generated keys could otherwise list without end.
      if (this.fields >= MAX_FIELDS) return undefined;
      this.fields++;
      node = { path, count: 0, types: new Map(), examples: new Set(), children: new Map(), seenIn: 0, typeSeenIn: new Map() };
      level.set(key, node);
    }
    return node;
  }
}

/** Each field is followed by its nested fields, in the order they were first seen. */
function collect(level: Map<string, FieldNode>, into: MongoFieldStats[]): MongoFieldStats[] {
  for (const node of level.values()) {
    into.push({
      path: node.path,
      count: node.count,
      types: [...node.types].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      examples: [...node.examples],
    });
    collect(node.children, into);
  }
  return into;
}

export function analyzeSchema(documents: readonly Document[]): MongoSchema {
  const builder = new SchemaBuilder();
  for (const document of documents) builder.add(document);
  return { sampled: documents.length, fields: collect(builder.root, []) };
}
