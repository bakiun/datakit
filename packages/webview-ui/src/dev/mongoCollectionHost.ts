import type {
  MongoBsonType,
  MongoCollectionHostMessage,
  MongoCollectionInfo,
  MongoCollectionWebviewMessage,
  MongoDocument,
  MongoEdit,
  MongoExplain,
  MongoFieldStats,
  MongoFindQuery,
  MongoIndex,
  MongoSchema,
  MongoWriteResult,
} from '@datakit/core';

/**
 * Plays the extension for the MongoDB collection view on the dev server: an `orders` collection of 120 documents in
 * memory. Texts the page sends are read with `new Function` (dev only), so filters, documents and shell lines may
 * use `ObjectId()`, `ISODate()`, `NumberDecimal()` and `NumberLong()`. Filters understand equality, `$gt`-style
 * comparisons, `$in`, `$exists`, `$regex`, `$and` and `$or`; pipelines `$match`, `$project`, `$group`, `$sort`,
 * `$limit`, `$skip`, `$unwind`, `$lookup` (empty) and `$count`. A text containing `fail` fails.
 * Query: `&readonly`, `&production`, `&view-collection` (a view on orders), `&capped`, `&initfail`, `&nocount`
 * (counts come back unknown).
 */

class Oid {
  constructor(readonly hex: string) {}
}
class IsoDate {
  constructor(readonly iso: string) {}
}
class Dec {
  constructor(readonly value: string) {}
}
class Long {
  constructor(readonly value: string) {}
}
type Value = string | number | boolean | null | Oid | IsoDate | Dec | Long | Value[] | { [key: string]: Value };
type Doc = { [key: string]: Value };

const isPlain = (v: unknown): v is Doc => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A value in shell syntax as mongosh prints it, objects over several lines unless `inline`. */
function shell(v: Value | undefined, indent = 0, inline = false): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Oid) return `ObjectId("${v.hex}")`;
  if (v instanceof IsoDate) return `ISODate("${v.iso}")`;
  if (v instanceof Dec) return `NumberDecimal("${v.value}")`;
  if (v instanceof Long) return `NumberLong("${v.value}")`;
  const pad = ' '.repeat(indent + 2);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const flat = `[ ${v.map((x) => shell(x, 0, true)).join(', ')} ]`;
    if (inline || (flat.length <= 72 && v.every((x) => !isPlain(x) && !Array.isArray(x)))) return flat;
    return `[\n${v.map((x) => pad + shell(x, indent + 2)).join(',\n')}\n${' '.repeat(indent)}]`;
  }
  const entries = Object.entries(v);
  if (!entries.length) return '{}';
  const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
  if (inline) return `{ ${entries.map(([k, x]) => `${key(k)}: ${shell(x, 0, true)}`).join(', ')} }`;
  return `{\n${entries.map(([k, x]) => `${pad}${key(k)}: ${shell(x, indent + 2)}`).join(',\n')}\n${' '.repeat(indent)}}`;
}

function typeOf(v: Value): MongoBsonType {
  if (v === null) return 'Null';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Boolean';
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? 'Int32' : 'Double';
  if (v instanceof Oid) return 'ObjectId';
  if (v instanceof IsoDate) return 'Date';
  if (v instanceof Dec) return 'Decimal128';
  if (v instanceof Long) return 'Int64';
  return Array.isArray(v) ? 'Array' : 'Object';
}

/** The `_id` as canonical Extended JSON. */
function ejson(v: Value | undefined): string | null {
  if (v === undefined) return null;
  if (v instanceof Oid) return JSON.stringify({ $oid: v.hex });
  if (typeof v === 'number') return JSON.stringify(Number.isInteger(v) ? { $numberInt: String(v) } : { $numberDouble: String(v) });
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(shell(v, 0, true));
}

// ---- Reading texts the page sends (dev only).

function hexId(): string {
  const time = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  return time + Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

const BSON: Record<string, unknown> = {
  ObjectId: (hex?: string) => new Oid(hex ?? hexId()),
  ISODate: (iso?: string) => new IsoDate((iso ? new Date(iso) : new Date()).toISOString()),
  NumberDecimal: (x: string | number) => new Dec(String(x)),
  Decimal128: (x: string | number) => new Dec(String(x)),
  NumberLong: (x: string | number) => new Long(String(x)),
  Long: (x: string | number) => new Long(String(x)),
  NumberInt: (x: string | number) => Math.trunc(Number(x)),
  Int32: (x: string | number) => Math.trunc(Number(x)),
  Double: (x: string | number) => Number(x),
};

/** JS values from `new Function` back to the stand-ins: dates and regular expressions. */
function normalize(v: unknown): Value {
  if (v instanceof Date) return new IsoDate(v.toISOString());
  if (v instanceof RegExp) return v.toString();
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(normalize);
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v as Value;
}

function evaluate(text: string, scope: Record<string, unknown> = {}): unknown {
  const all = { ...BSON, ...scope };
  // Regular functions so `new ObjectId()` works too.
  const args = Object.values(all).map((f) => (typeof f === 'function' ? function (this: unknown, ...a: unknown[]) { return (f as (...x: unknown[]) => unknown)(...a); } : f));
  return new Function(...Object.keys(all), `"use strict";\nreturn (${text}\n);`)(...args) as unknown;
}

/** A query text: null when empty, an error naming the field when it cannot be read. */
function readObject(label: string, text: string): Doc | null {
  if (!text.trim()) return null;
  if (/fail/i.test(text)) throw new Error(`${label}: Unexpected token, expected "," (1:${Math.max(1, text.indexOf('fail'))})`);
  let value: unknown;
  try {
    value = evaluate(text);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlain(value)) throw new Error(`${label}: must be an object, e.g. { field: 1 }`);
  return normalize(value) as Doc;
}

// ---- Queries.

function get(doc: Value, path: string): Value | undefined {
  let at: Value | undefined = doc;
  for (const step of path.split('.')) {
    if (Array.isArray(at)) {
      const values: Value[] = at.map((x) => (isPlain(x) ? x[step] : undefined)).filter((x): x is Value => x !== undefined);
      at = values;
    } else if (isPlain(at)) at = at[step];
    else return undefined;
  }
  return at;
}

function setPath(doc: Doc, path: string, value: Value): void {
  const steps = path.split('.');
  let at: Doc = doc;
  for (const step of steps.slice(0, -1)) {
    if (!isPlain(at[step])) at[step] = {};
    at = at[step] as Doc;
  }
  at[steps[steps.length - 1]!] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const steps = path.split('.');
  let at: Value | undefined = doc;
  for (const step of steps.slice(0, -1)) at = isPlain(at) ? at[step] : undefined;
  if (isPlain(at)) delete at[steps[steps.length - 1]!];
}

function scalar(v: Value | undefined): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Dec || v instanceof Long) return Number(v.value);
  if (v instanceof IsoDate) return v.iso;
  if (v instanceof Oid) return v.hex;
  if (typeof v === 'object') return shell(v, 0, true);
  return v;
}

function compare(a: Value | undefined, b: Value | undefined): number {
  const x = scalar(a);
  const y = scalar(b);
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return x < y ? -1 : 1;
}

function equal(a: Value | undefined, b: Value): boolean {
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => equal(x, b));
  return shell(a ?? null, 0, true) === shell(b, 0, true);
}

function test(value: Value | undefined, condition: Value): boolean {
  if (!isPlain(condition) || !Object.keys(condition).every((k) => k.startsWith('$'))) return equal(value, condition);
  return Object.entries(condition).every(([op, arg]) => {
    const many = Array.isArray(value) ? value : [value];
    switch (op) {
      case '$eq':
        return equal(value, arg);
      case '$ne':
        return !equal(value, arg);
      case '$gt':
        return many.some((v) => v !== undefined && compare(v, arg) > 0);
      case '$gte':
        return many.some((v) => v !== undefined && compare(v, arg) >= 0);
      case '$lt':
        return many.some((v) => v !== undefined && compare(v, arg) < 0);
      case '$lte':
        return many.some((v) => v !== undefined && compare(v, arg) <= 0);
      case '$in':
        return Array.isArray(arg) && arg.some((x) => equal(value, x));
      case '$nin':
        return Array.isArray(arg) && !arg.some((x) => equal(value, x));
      case '$exists':
        return (value !== undefined) === !!arg;
      case '$regex': {
        const m = /^\/(.*)\/([a-z]*)$/.exec(String(arg));
        const re = m ? new RegExp(m[1]!, m[2]) : new RegExp(String(arg));
        return many.some((v) => typeof v === 'string' && re.test(v));
      }
      default:
        throw new Error(`unknown operator: ${op}`);
    }
  });
}

function matches(doc: Doc, filter: Doc | null): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return Array.isArray(condition) && condition.every((c) => matches(doc, c as Doc));
    if (key === '$or') return Array.isArray(condition) && condition.some((c) => matches(doc, c as Doc));
    if (key.startsWith('$')) throw new Error(`unknown top level operator: ${key}`);
    if (typeof condition === 'string' && /^\/.*\/[a-z]*$/.test(condition)) return test(get(doc, key), { $regex: condition });
    return test(get(doc, key), condition);
  });
}

function sortBy(docs: Doc[], sort: Doc | null): Doc[] {
  if (!sort) return docs;
  const keys = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [k, dir] of keys) {
      const c = compare(get(a, k), get(b, k));
      if (c) return Number(dir) < 0 ? -c : c;
    }
    return 0;
  });
}

function project(doc: Doc, projection: Doc | null): Doc {
  if (!projection) return doc;
  const entries = Object.entries(projection);
  const including = entries.some(([k, v]) => k !== '_id' && !!v);
  if (including) {
    const out: Doc = {};
    if (projection._id !== 0 && projection._id !== false && doc._id !== undefined) out._id = doc._id;
    for (const [k, v] of entries) {
      if (k === '_id' || !v) continue;
      const value = typeof v === 'string' && v.startsWith('$') ? get(doc, v.slice(1)) : get(doc, k);
      if (value !== undefined) setPath(out, k, value);
    }
    return out;
  }
  const out = structuredCloneDoc(doc);
  for (const [k] of entries) unsetPath(out, k);
  return out;
}

function structuredCloneDoc(doc: Doc): Doc {
  const copy = (v: Value): Value => (Array.isArray(v) ? v.map(copy) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v);
  return copy(doc) as Doc;
}

function numberOf(v: Value | undefined): number {
  const s = scalar(v);
  return typeof s === 'number' ? s : Number(s) || 0;
}

function group(docs: Doc[], spec: Doc): Doc[] {
  const groups = new Map<string, { id: Value; docs: Doc[] }>();
  const idOf = (d: Doc): Value => {
    const id = spec._id ?? null;
    if (typeof id === 'string' && id.startsWith('$')) return get(d, id.slice(1)) ?? null;
    if (isPlain(id)) return Object.fromEntries(Object.entries(id).map(([k, x]) => [k, typeof x === 'string' && x.startsWith('$') ? (get(d, x.slice(1)) ?? null) : x]));
    return id;
  };
  for (const d of docs) {
    const id = idOf(d);
    const key = shell(id, 0, true);
    const g = groups.get(key) ?? { id, docs: [] };
    g.docs.push(d);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ id, docs: members }) => {
    const out: Doc = { _id: id };
    for (const [field, acc] of Object.entries(spec)) {
      if (field === '_id' || !isPlain(acc)) continue;
      const [op, arg] = Object.entries(acc)[0] ?? ['', null];
      const values = members.map((m) => (typeof arg === 'string' && arg.startsWith('$') ? get(m, arg.slice(1)) : arg)).filter((v): v is Value => v !== undefined);
      const nums = values.map(numberOf);
      switch (op) {
        case '$sum':
          out[field] = Math.round(nums.reduce((n, x) => n + x, 0) * 100) / 100;
          break;
        case '$avg':
          out[field] = nums.length ? Math.round((nums.reduce((n, x) => n + x, 0) / nums.length) * 100) / 100 : null;
          break;
        case '$min':
          out[field] = values.reduce<Value | null>((m, v) => (m === null || compare(v, m) < 0 ? v : m), null);
          break;
        case '$max':
          out[field] = values.reduce<Value | null>((m, v) => (m === null || compare(v, m) > 0 ? v : m), null);
          break;
        case '$first':
          out[field] = values[0] ?? null;
          break;
        case '$push':
          out[field] = values;
          break;
        default:
          throw new Error(`unknown group operator '${op}'`);
      }
    }
    return out;
  });
}

function runPipeline(source: Doc[], stages: unknown): Doc[] {
  if (!Array.isArray(stages)) throw new Error('A pipeline is an array of stages, e.g. [ { $match: {} } ].');
  let docs = source;
  for (const raw of stages) {
    const stage = normalize(raw);
    if (!isPlain(stage) || Object.keys(stage).length !== 1) throw new Error('A pipeline stage specification object must contain exactly one field.');
    const [op, arg] = Object.entries(stage)[0]!;
    switch (op) {
      case '$match':
        docs = docs.filter((d) => matches(d, arg as Doc));
        break;
      case '$project':
        docs = docs.map((d) => project(d, arg as Doc));
        break;
      case '$sort':
        docs = sortBy(docs, arg as Doc);
        break;
      case '$limit':
        docs = docs.slice(0, numberOf(arg));
        break;
      case '$skip':
        docs = docs.slice(numberOf(arg));
        break;
      case '$count':
        docs = [{ [String(arg)]: docs.length }];
        break;
      case '$group':
        docs = group(docs, arg as Doc);
        break;
      case '$unwind': {
        const path = String(isPlain(arg) ? arg.path : arg).replace(/^\$/, '');
        docs = docs.flatMap((d) => {
          const list = get(d, path);
          if (!Array.isArray(list)) return list === undefined ? [] : [d];
          return list.map((item) => {
            const copy = structuredCloneDoc(d);
            setPath(copy, path, item);
            return copy;
          });
        });
        break;
      }
      case '$lookup':
        docs = docs.map((d) => ({ ...d, [String((arg as Doc).as ?? 'joined')]: [] }));
        break;
      default:
        throw new Error(`Unrecognized pipeline stage name: '${op}'`);
    }
  }
  return docs;
}

// ---- Documents as the page sees them.

function toDocument(doc: Doc, truncated = false): MongoDocument {
  let text = shell(doc);
  if (truncated) text = `${text.split('\n').slice(0, 30).join('\n')}\n  …`;
  return {
    id: ejson(doc._id),
    idText: doc._id === undefined ? null : shell(doc._id, 0, true),
    text,
    truncated,
    fields: Object.entries(doc).map(([name, v]) => {
      const preview = shell(v, 0, true);
      return { name, type: typeOf(v), preview: preview.slice(0, 200), complete: preview.length <= 200 };
    }),
    size: truncated ? 1_342_177 : Math.round(shell(doc, 0, true).length * 0.8),
  };
}

// ---- Sample data.

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed(): Doc[] {
  const rnd = random(20261024);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)]!;
  const customers = [
    ['Daniel Adams', 'daniel@example.com', 'gold'],
    ['Alice Kent', 'alice.k@example.com', 'silver'],
    ['Mark Young', 'm.young@example.com', 'standard'],
    ['Petra Novak', 'p.novak@example.cz', 'gold'],
    ['Hana Sato', 'hana.sato@example.com', 'standard'],
    ['Jonas Weber', 'jonas.weber@example.com', 'silver'],
    ['Claire Martin', 'c.martin@example.com', 'standard'],
    ['Emily Carter', 'emily.carter@example.com', 'gold'],
  ] as const;
  const products = [
    ['TS-1024', 'Terminal stand', 899.0],
    ['MG-220', 'Magnetic cable', 149.5],
    ['KB-75', 'Keyboard 75%', 1249.9],
    ['MS-08', 'Silent mouse', 329.0],
    ['HB-4', 'USB-C hub', 449.99],
    ['LP-13', 'Laptop sleeve', 279.0],
  ] as const;
  const statuses = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'delivered', 'pending', 'cancelled', 'refunded'] as const;
  const base = Date.UTC(2026, 9, 24, 12, 0, 0);
  const docs: Doc[] = [];
  for (let i = 0; i < 120; i++) {
    const created = base - i * 37 * 60_000 - Math.floor(rnd() * 600_000);
    const hex = Math.floor(created / 1000).toString(16).padStart(8, '0') + Array.from({ length: 16 }, () => Math.floor(rnd() * 16).toString(16)).join('');
    const [name, email, tier] = pick(customers);
    const status = pick(statuses);
    const items = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
      const [sku, title, price] = pick(products);
      return { sku, name: title, qty: 1 + Math.floor(rnd() * 3), price: new Dec(price.toFixed(2)) };
    });
    const total = items.reduce((n, it) => n + Number(it.price.value) * it.qty, 0);
    const doc: Doc = {
      _id: new Oid(hex),
      orderNo: 10001 + i,
      status,
      customer: { name, email, tier },
      items,
      total: new Dec(total.toFixed(2)),
      currency: pick(['EUR', 'USD', 'TRY']),
      createdAt: new IsoDate(new Date(created).toISOString()),
    };
    if (status === 'shipped' || status === 'delivered') doc.shippedAt = new IsoDate(new Date(created + 86_400_000 + Math.floor(rnd() * 86_400_000)).toISOString());
    if (rnd() < 0.3) doc.tags = rnd() < 0.5 ? ['gift'] : ['express', 'gift-wrap'];
    if (rnd() < 0.2) doc.discount = rnd() < 0.5 ? null : new Dec((total * 0.1).toFixed(2));
    if (rnd() < 0.1) doc.notes = 'Leave the parcel with the neighbour at number 12 if nobody answers; call before delivery.';
    docs.push(doc);
  }
  // A few documents the schema should notice: a total stored as text, an Int64, and a flag that is a string.
  docs[7]!.total = '129.90';
  docs[12]!.legacyId = new Long('9007199254740993');
  docs[30]!.paidOnline = 'yes';
  docs[31]!.paidOnline = true;
  return docs;
}

const INDEX_SINCE = Date.UTC(2026, 9, 1);

function seedIndexes(): MongoIndex[] {
  const base = { unique: false, sparse: false, hidden: false, ttlSeconds: null, partialFilter: null, usageSince: INDEX_SINCE };
  return [
    { ...base, name: '_id_', keys: '{ _id: 1 }', bytes: 36_864, ops: 18_204 },
    { ...base, name: 'status_1_createdAt_-1', keys: '{ status: 1, createdAt: -1 }', bytes: 28_672, ops: 9_412 },
    { ...base, name: 'customer.email_1', keys: '{ "customer.email": 1 }', unique: true, bytes: 20_480, ops: 311 },
    { ...base, name: 'total_-1', keys: '{ total: -1 }', partialFilter: '{ status: "paid" }', bytes: 12_288, ops: 0 },
    { ...base, name: 'archivedAt_1', keys: '{ archivedAt: 1 }', sparse: true, ttlSeconds: 7_776_000, bytes: 4_096, ops: null, usageSince: null },
    { ...base, name: 'notes_text', keys: '{ notes: "text" }', hidden: true, bytes: 61_440, ops: 2 },
  ];
}

// ---- Schema.

function analyze(docs: Doc[]): MongoSchema {
  const stats = new Map<string, { count: number; types: Map<MongoBsonType, number>; examples: string[] }>();
  for (const doc of docs) {
    const seen = new Set<string>();
    const visit = (value: Value, path: string) => {
      let s = stats.get(path);
      if (!s) stats.set(path, (s = { count: 0, types: new Map(), examples: [] }));
      if (!seen.has(path)) {
        seen.add(path);
        s.count++;
      }
      const type = typeOf(value);
      s.types.set(type, (s.types.get(type) ?? 0) + 1);
      if (type !== 'Object' && type !== 'Array' && s.examples.length < 3) {
        const text = shell(value, 0, true).slice(0, 60);
        if (!s.examples.includes(text)) s.examples.push(text);
      }
      if (isPlain(value)) for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
      if (Array.isArray(value)) for (const item of value) if (isPlain(item)) for (const [k, v] of Object.entries(item)) visit(v, `${path}[].${k}`);
    };
    for (const [k, v] of Object.entries(doc)) visit(v, k);
  }
  const fields: MongoFieldStats[] = [...stats].map(([path, s]) => ({
    path,
    count: s.count,
    types: [...s.types].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    examples: s.examples,
  }));
  return { sampled: docs.length, fields };
}

// ---- The host.

export function installMongoCollectionHost(reply: (message: MongoCollectionHostMessage, delay?: number) => void): (message: MongoCollectionWebviewMessage) => void {
  const params = new URLSearchParams(location.search);
  const readOnly = params.has('readonly');
  const production = params.has('production');
  const isView = params.has('view-collection');
  const capped = params.has('capped');
  const noCount = params.has('nocount');
  const docs = seed();
  const indexes = seedIndexes();
  /** The 42nd order is over 1 MiB: only its start is sent. */
  const truncatedId = ejson(docs[41]!._id);
  let shellDb = 'shop';

  const VIEW_PIPELINE = '[\n  { $match: { status: "paid" } },\n  { $project: { items: 0 } }\n]';
  const source = (): Doc[] => (isView ? runPipeline(docs, evaluate(VIEW_PIPELINE)) : docs);
  const info = (): MongoCollectionInfo => ({
    name: isView ? 'paid_orders' : 'orders',
    type: isView ? 'view' : 'collection',
    documents: isView ? null : docs.length,
    bytes: isView ? null : docs.reduce((n, d) => n + toDocument(d).size, 0),
    capped,
    viewOn: isView ? 'orders' : null,
    pipeline: isView ? VIEW_PIPELINE : null,
  });
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const shown = (d: Doc) => toDocument(d, ejson(d._id) === truncatedId);
  const byId = (id: string) => docs.findIndex((d) => ejson(d._id) === id);

  function find(q: MongoFindQuery): { documents: MongoDocument[]; count: number | null } {
    const filter = readObject('Filter', q.filter);
    const projection = readObject('Projection', q.projection);
    const sort = readObject('Sort', q.sort);
    readObject('Collation', q.collation);
    const matched = sortBy(
      source().filter((d) => matches(d, filter)),
      sort,
    );
    return { documents: matched.slice(q.skip, q.skip + q.limit).map((d) => shown(project(d, projection))), count: noCount ? null : matched.length };
  }

  function explain(query: MongoFindQuery | { pipeline: string }): MongoExplain {
    const filter = 'pipeline' in query ? null : readObject('Filter', query.filter);
    if ('pipeline' in query && /fail/i.test(query.pipeline)) throw new Error("Unrecognized pipeline stage name: '$fail'");
    const pipelineMatch = 'pipeline' in query ? /\$match:\s*\{\s*(\w+)/.exec(query.pipeline)?.[1] : undefined;
    const field = filter ? Object.keys(filter)[0] : pipelineMatch;
    const index = field === 'status' ? 'status_1_createdAt_-1' : field === 'customer.email' ? 'customer.email_1' : null;
    const matched = docs.filter((d) => matches(d, filter));
    const limit = 'pipeline' in query ? matched.length : query.limit;
    const returned = Math.min(matched.length, limit);
    const docsExamined = index ? returned : docs.length;
    const stages = [...('pipeline' in query ? [] : query.sort && !index ? ['SORT'] : []), 'LIMIT', ...(index ? ['FETCH', 'IXSCAN'] : ['COLLSCAN'])];
    const plan = stages.reduceRight<Value>((input, stage) => {
      const node: Doc = { stage };
      if (stage === 'IXSCAN') Object.assign(node, { keyPattern: { status: 1, createdAt: -1 }, indexName: index, direction: 'forward' });
      if (stage === 'LIMIT') node.limitAmount = limit;
      if (input !== null) node.inputStage = input;
      return node;
    }, null);
    const text = shell({
      explainVersion: '1',
      queryPlanner: { namespace: 'shop.orders', parsedQuery: filter ?? {}, winningPlan: plan, rejectedPlans: [] },
      executionStats: { executionSuccess: true, nReturned: returned, executionTimeMillis: 3, totalKeysExamined: index ? returned : 0, totalDocsExamined: docsExamined },
      serverInfo: { host: 'mongo-0.local', port: 27017, version: '8.0.4' },
      ok: 1,
    });
    return { stages, index, returned, docsExamined, keysExamined: index ? returned : 0, timeMs: index ? 1 : 3, text };
  }

  function applyUpdate(doc: Doc, update: Doc): void {
    for (const [op, fields] of Object.entries(update)) {
      if (!isPlain(fields)) throw new Error(`Modifiers operate on fields but we found type ${typeOf(fields).toLowerCase()} instead.`);
      for (const [path, value] of Object.entries(fields)) {
        if (op === '$set') setPath(doc, path, value);
        else if (op === '$unset') unsetPath(doc, path);
        else if (op === '$inc') setPath(doc, path, numberOf(get(doc, path)) + numberOf(value));
        else if (op === '$push') {
          const list = get(doc, path);
          setPath(doc, path, [...(Array.isArray(list) ? list : []), value]);
        } else throw new Error(`Unknown modifier: ${op}. Expected a valid update modifier or pipeline-style update.`);
      }
    }
  }

  const done = (summary: string, affected: number, insertedIds: string[] = []): MongoWriteResult => ({ summary, affected, insertedIds });
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function write(edit: MongoEdit): MongoWriteResult {
    switch (edit.kind) {
      case 'insert': {
        if (/fail/i.test(edit.text)) throw new Error('E11000 duplicate key error collection: shop.orders index: _id_ dup key: { _id: ObjectId("6719f0c2a1b2c3d4e5f60718") }');
        const value = normalize(evaluate(edit.text));
        const list = Array.isArray(value) ? value : [value];
        if (!list.length || !list.every(isPlain)) throw new Error('Insert one document ({ … }) or an array of documents.');
        const ids = list.map((d) => {
          const doc = d as Doc;
          const withId: Doc = doc._id === undefined ? { _id: new Oid(hexId()), ...doc } : doc;
          docs.unshift(withId);
          return ejson(withId._id)!;
        });
        return done(`Inserted ${plural(ids.length, 'document')}`, ids.length, ids);
      }
      case 'replace': {
        const at = byId(edit.id);
        if (at < 0) throw new Error('No document has this _id any more.');
        const value = normalize(evaluate(edit.text));
        if (!isPlain(value)) throw new Error('A document is an object: { … }.');
        if (value._id !== undefined && ejson(value._id) !== edit.id) throw new Error("After applying the update, the (immutable) field '_id' was found to have been altered.");
        docs[at] = { _id: docs[at]!._id!, ...value };
        return done('Replaced 1 document', 1);
      }
      case 'setField': {
        const at = byId(edit.id);
        if (at < 0) throw new Error('No document has this _id any more.');
        setPath(docs[at]!, edit.path, normalize(evaluate(edit.value)));
        return done(`Updated 1 document: set ${edit.path}`, 1);
      }
      case 'unsetField': {
        const at = byId(edit.id);
        if (at < 0) throw new Error('No document has this _id any more.');
        unsetPath(docs[at]!, edit.path);
        return done(`Updated 1 document: removed ${edit.path}`, 1);
      }
      case 'delete': {
        let n = 0;
        for (const id of edit.ids) {
          const at = byId(id);
          if (at >= 0) {
            docs.splice(at, 1);
            n++;
          }
        }
        return done(`Deleted ${plural(n, 'document')}`, n);
      }
      case 'deleteMatching': {
        const filter = readObject('Filter', edit.filter);
        if (!filter || !Object.keys(filter).length) throw new Error('An empty filter is refused: it would delete every document.');
        const before = docs.length;
        for (let i = docs.length - 1; i >= 0; i--) if (matches(docs[i]!, filter)) docs.splice(i, 1);
        return done(`Deleted ${plural(before - docs.length, 'document')}`, before - docs.length);
      }
      case 'updateMatching': {
        const filter = readObject('Filter', edit.filter);
        if (/fail/i.test(edit.update)) throw new Error('Update: Unexpected token (1:3)');
        const update = normalize(evaluate(edit.update));
        if (Array.isArray(update)) throw new Error('Pipeline updates are not faked by the dev host.');
        if (!isPlain(update) || !Object.keys(update).length) throw new Error('Update document requires atomic operators, e.g. { $set: { … } }.');
        const hit = docs.filter((d) => matches(d, filter));
        for (const d of hit) applyUpdate(d, update);
        return done(`Matched ${plural(hit.length, 'document')}, updated ${hit.length}`, hit.length);
      }
      case 'createIndex': {
        const keys = readObject('Keys', edit.spec.keys);
        if (!keys || !Object.keys(keys).length) throw new Error('Index keys cannot be empty.');
        const name = edit.spec.name || Object.entries(keys).map(([k, v]) => `${k}_${String(v)}`).join('_');
        if (indexes.some((i) => i.name === name)) throw new Error(`An index with the name ${name} already exists with different options.`);
        indexes.push({
          name,
          keys: shell(keys, 0, true),
          unique: edit.spec.unique,
          sparse: edit.spec.sparse,
          hidden: edit.spec.hidden,
          ttlSeconds: edit.spec.ttlSeconds,
          partialFilter: edit.spec.partialFilter || null,
          bytes: 4_096,
          ops: 0,
          usageSince: Date.now(),
        });
        return done(`Created index ${name}`, 1);
      }
      case 'dropIndex': {
        if (edit.name === '_id_') throw new Error('cannot drop _id index');
        const at = indexes.findIndex((i) => i.name === edit.name);
        if (at < 0) throw new Error(`index not found with name [${edit.name}]`);
        indexes.splice(at, 1);
        return done(`Dropped index ${edit.name}`, 1);
      }
      case 'hideIndex': {
        const index = indexes.find((i) => i.name === edit.name);
        if (!index) throw new Error(`index not found with name [${edit.name}]`);
        index.hidden = edit.hidden;
        return done(`${edit.hidden ? 'Hid' : 'Unhid'} index ${edit.name}`, 1);
      }
    }
  }

  /** `db` for shell lines: collections by name, with the methods people type most. */
  function shellDbObject(wrote: { value: boolean }): unknown {
    const collection = (name: string) => {
      const data = shellDb === 'shop' && name === 'orders' ? docs : [];
      const cursor = (list: Doc[]) => {
        const c = {
          list,
          limit: (n: number) => cursor(list.slice(0, n)),
          skip: (n: number) => cursor(list.slice(n)),
          sort: (s: Doc) => cursor(sortBy(list, normalize(s) as Doc)),
          toArray: () => list,
          count: () => list.length,
        };
        return c;
      };
      return {
        find: (filter?: unknown, projection?: unknown) => cursor(data.filter((d) => matches(d, normalize(filter ?? null) as Doc | null)).map((d) => project(d, normalize(projection ?? null) as Doc | null))),
        findOne: (filter?: unknown) => data.find((d) => matches(d, normalize(filter ?? null) as Doc | null)) ?? null,
        countDocuments: (filter?: unknown) => data.filter((d) => matches(d, normalize(filter ?? null) as Doc | null)).length,
        estimatedDocumentCount: () => data.length,
        distinct: (field: string) => [...new Map(data.map((d) => get(d, field)).filter((v): v is Value => v !== undefined).map((v) => [shell(v, 0, true), v])).values()],
        aggregate: (stages: unknown) => runPipeline(data, stages),
        getIndexes: () => (data === docs ? indexes.map((i) => ({ v: 2, key: normalize(evaluate(i.keys)), name: i.name })) : []),
        insertOne: (doc: unknown) => {
          wrote.value = true;
          const r = write({ kind: 'insert', text: shell(normalize(doc)) });
          return { acknowledged: true, insertedId: new Oid(JSON.parse(r.insertedIds[0]!).$oid as string) };
        },
        updateMany: (filter: unknown, update: unknown) => {
          wrote.value = true;
          const hit = data.filter((d) => matches(d, normalize(filter) as Doc));
          for (const d of hit) applyUpdate(d, normalize(update) as Doc);
          return { acknowledged: true, insertedId: null, matchedCount: hit.length, modifiedCount: hit.length, upsertedCount: 0 };
        },
        updateOne: (filter: unknown, update: unknown) => {
          wrote.value = true;
          const hit = data.find((d) => matches(d, normalize(filter) as Doc));
          if (hit) applyUpdate(hit, normalize(update) as Doc);
          return { acknowledged: true, insertedId: null, matchedCount: hit ? 1 : 0, modifiedCount: hit ? 1 : 0, upsertedCount: 0 };
        },
        deleteMany: (filter: unknown) => {
          wrote.value = true;
          const f = normalize(filter) as Doc;
          const before = data.length;
          for (let i = data.length - 1; i >= 0; i--) if (matches(data[i]!, f)) data.splice(i, 1);
          return { acknowledged: true, deletedCount: before - data.length };
        },
        deleteOne: (filter: unknown) => {
          wrote.value = true;
          const at = data.findIndex((d) => matches(d, normalize(filter) as Doc));
          if (at >= 0) data.splice(at, 1);
          return { acknowledged: true, deletedCount: at >= 0 ? 1 : 0 };
        },
      };
    };
    return new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'getName') return () => shellDb;
          if (prop === 'getCollectionNames') return () => (shellDb === 'shop' ? ['orders', 'paid_orders'] : []);
          if (prop === 'getCollection') return collection;
          return typeof prop === 'string' ? collection(prop) : undefined;
        },
      },
    );
  }

  function printed(result: unknown): string {
    if (result === undefined) return '';
    if (isPlain(result) && Array.isArray(result.list) && typeof result.toArray === 'function') {
      const list = result.list as Doc[];
      const shownDocs = list.slice(0, 20);
      return `${shell(shownDocs)}${list.length > 20 ? `\nType "it" for more (${list.length - 20} more documents)` : ''}`;
    }
    return shell(normalize(result));
  }

  function runShell(line: string): { output: string; ok: boolean; wrote: boolean } {
    const text = line.trim();
    if (/fail/i.test(text)) return { output: `MongoServerError[CommandNotFound]: no such command: '${text.split(/[\s(]/)[0]}'`, ok: false, wrote: false };
    const use = /^use\s+(\S+)$/.exec(text);
    if (use) {
      shellDb = use[1]!;
      return { output: `switched to db ${shellDb}`, ok: true, wrote: false };
    }
    if (/^show\s+(dbs|databases)$/.test(text)) return { output: 'admin   40.00 KiB\nconfig  72.00 KiB\nlocal   1.20 MiB\nshop    2.31 MiB', ok: true, wrote: false };
    if (/^show\s+collections$/.test(text)) return { output: shellDb === 'shop' ? 'orders\npaid_orders' : '', ok: true, wrote: false };
    const wrote = { value: false };
    if ((readOnly || isView) && /\.(insert|update|delete|replace|drop|create)/.test(text)) return { output: 'MongoshInvalidInputError: The data source is read-only.', ok: false, wrote: false };
    try {
      const result = evaluate(text, { db: shellDbObject(wrote) });
      return { output: printed(result), ok: true, wrote: wrote.value };
    } catch (error) {
      return { output: `${error instanceof SyntaxError ? 'SyntaxError' : 'MongoServerError'}: ${message(error)}`, ok: false, wrote: wrote.value };
    }
  }

  return (msg) => {
    switch (msg.type) {
      case 'ready':
        if (params.has('initfail')) {
          reply({ type: 'initFailed', message: 'Could not open shop.orders: connect ECONNREFUSED 127.0.0.1:27017' }, 300);
          break;
        }
        reply(
          {
            type: 'init',
            init: {
              dataSourceName: 'shop-mongo',
              environment: production ? 'production' : 'development',
              serverLabel: 'MongoDB 8.0.4',
              topology: 'Replica set rs0',
              database: 'shop',
              collection: isView ? 'paid_orders' : 'orders',
              type: isView ? 'view' : 'collection',
              readOnly,
              pageSize: 50,
              info: info(),
            },
          },
          150,
        );
        break;
      case 'find':
        try {
          const page = find(msg.query);
          reply({ type: 'page', requestId: msg.requestId, page, durationMs: 4 + Math.random() * 20 }, 180);
        } catch (error) {
          reply({ type: 'pageFailed', requestId: msg.requestId, message: message(error) }, 120);
        }
        break;
      case 'aggregate':
        try {
          if (/fail/i.test(msg.pipeline)) throw new Error("Unrecognized pipeline stage name: '$fail'");
          const out = runPipeline(source(), evaluate(msg.pipeline)).slice(0, msg.limit);
          reply({ type: 'page', requestId: msg.requestId, page: { documents: out.map((d) => shown(d)), count: null }, durationMs: 8 + Math.random() * 40 }, 220);
        } catch (error) {
          reply({ type: 'pageFailed', requestId: msg.requestId, message: message(error) }, 150);
        }
        break;
      case 'explain':
        try {
          reply({ type: 'explain', explain: explain(msg.query) }, 250);
        } catch (error) {
          reply({ type: 'explainFailed', message: message(error) }, 150);
        }
        break;
      case 'load':
        if (msg.what === 'indexes') reply({ type: 'indexes', indexes: indexes.map((i) => ({ ...i })) }, 150);
        else if (msg.what === 'info') reply({ type: 'info', info: info() }, 100);
        else reply({ type: 'schema', schema: analyze(source().slice(0, msg.sample ?? 1000)) }, 400);
        break;
      case 'edit':
        if (production) console.info('[dev host] production: the extension asks in a VS Code modal before', msg.edit.kind);
        if (readOnly || isView) {
          reply({ type: 'writeFailed', kind: msg.edit.kind, message: isView ? 'Views are read-only.' : 'The data source is read-only.' }, 100);
          break;
        }
        try {
          reply({ type: 'written', kind: msg.edit.kind, result: write(msg.edit) }, 200);
        } catch (error) {
          reply({ type: 'writeFailed', kind: msg.edit.kind, message: message(error) }, 200);
        }
        break;
      case 'shell': {
        const started = performance.now();
        const result = runShell(msg.line);
        reply({ type: 'shell', line: msg.line, ...result, durationMs: performance.now() - started + 2, database: shellDb }, 120);
        break;
      }
      case 'export':
        reply({ type: 'notice', message: `Saved the matching documents as ${msg.format.toUpperCase()} (dev host).` }, 300);
        break;
      case 'copy':
        reply({ type: 'notice', message: `Copied ${msg.what} to the clipboard.` });
        break;
    }
  };
}
