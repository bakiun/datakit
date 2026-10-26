import type { MongoShellPlan, MongoShellResult } from '@datakit/core';
import { parse as parseJs, type CallExpression, type Identifier, type MemberExpression, type Node } from 'acorn';
import type { Collection, Document, MongoClient } from 'mongodb';
import { listDatabases, visibleCollections } from './databases';
import { cut, isDocument, parseWith, shellPrint, shellText, writingStage } from './values';

/**
 * A subset of mongosh: `show dbs`, `show collections`, `use <db>`, and one call chain on `db` per line, such as
 * `db.orders.find({ status: "A" }).sort({ created: -1 }).limit(5)`. The line is parsed with acorn; each argument is
 * parsed as a value in shell syntax, so nothing in the line runs as code.
 */

/** Documents a find or an aggregation prints when no limit asks for more. */
const SHELL_BATCH = 20;
/** At most this many documents print however high the limit. */
const SHELL_MAX = 1000;
const QUERY_TIME_MS = 60_000;
const COUNT_TIME_MS = 5_000;
const EXACT = { promoteValues: false } as const;

type Step = { kind: 'prop'; name: string } | { kind: 'call'; args: string[] };

const DATABASE_METHODS = ['getName', 'getCollectionNames', 'stats', 'runCommand', 'adminCommand', 'createCollection', 'dropDatabase'] as const;
type DatabaseMethod = (typeof DATABASE_METHODS)[number];

/** Collection methods, and whether they write. */
const COLLECTION_METHODS = {
  find: false,
  findOne: false,
  countDocuments: false,
  estimatedDocumentCount: false,
  distinct: false,
  aggregate: false,
  getIndexes: false,
  stats: false,
  insertOne: true,
  insertMany: true,
  updateOne: true,
  updateMany: true,
  replaceOne: true,
  deleteOne: true,
  deleteMany: true,
  findOneAndUpdate: true,
  findOneAndReplace: true,
  findOneAndDelete: true,
  createIndex: true,
  dropIndex: true,
  dropIndexes: true,
  drop: true,
  renameCollection: true,
} as const;
type CollectionMethod = keyof typeof COLLECTION_METHODS;

const CURSOR_METHODS: Partial<Record<CollectionMethod, readonly string[]>> = {
  find: ['sort', 'limit', 'skip', 'count', 'toArray', 'pretty', 'explain'],
  aggregate: ['toArray', 'pretty', 'explain'],
};

/** Commands `runCommand` and `adminCommand` may run without asking; the others may write. */
const READ_COMMANDS = new Set(
  [
    'find',
    'aggregate',
    'count',
    'distinct',
    'listCollections',
    'listIndexes',
    'listDatabases',
    'dbStats',
    'collStats',
    'serverStatus',
    'hello',
    'isMaster',
    'buildInfo',
    'ping',
    'connectionStatus',
    'hostInfo',
    'getParameter',
    'explain',
  ].map((name) => name.toLowerCase()),
);

interface CursorCall {
  method: string;
  args: unknown[];
}

type ShellCommand =
  | { kind: 'showDatabases' }
  | { kind: 'showCollections' }
  | { kind: 'use'; database: string }
  | { kind: 'db' }
  | { kind: 'namespace'; collection: string }
  | { kind: 'database'; method: DatabaseMethod; args: unknown[] }
  | { kind: 'collection'; collection: string; method: CollectionMethod; args: unknown[]; cursor: CursorCall[] };

const unsupported = (what: string) => new Error(`Not supported in this shell: ${cut(what, 120)}`);

function memberName(node: MemberExpression, source: string): string {
  if (!node.computed && node.property.type === 'Identifier') return (node.property as Identifier).name;
  if (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string') return node.property.value;
  throw unsupported(source.slice(node.start, node.end));
}

/** `db.a.find(x).limit(5)` as `[prop a, prop find, call (x), prop limit, call (5)]`; anything not rooted at `db` is refused. */
function flatten(node: Node, source: string): Step[] {
  switch (node.type) {
    case 'Identifier':
      if ((node as Identifier).name === 'db') return [];
      break;
    case 'MemberExpression': {
      const member = node as MemberExpression;
      if (member.optional || member.object.type === 'Super') break;
      return [...flatten(member.object, source), { kind: 'prop', name: memberName(member, source) }];
    }
    case 'CallExpression': {
      const call = node as CallExpression;
      if (call.optional || call.callee.type === 'Super' || call.arguments.some((a) => a.type === 'SpreadElement')) break;
      return [...flatten(call.callee, source), { kind: 'call', args: call.arguments.map((a) => source.slice(a.start, a.end)) }];
    }
  }
  throw unsupported(source.slice(node.start, node.end));
}

function parseArgs(args: string[], name: string): unknown[] {
  return args.map((arg, i) => parseWith(`Argument ${i + 1} of ${name}()`, arg));
}

function stringArg(args: unknown[], index: number, name: string): string {
  const value = args[index];
  if (typeof value !== 'string') throw new Error(`${name}() needs a name as argument ${index + 1}, e.g. "orders".`);
  return value;
}

function interpret(steps: Step[], source: string): ShellCommand {
  const [first, second] = steps;
  if (!first) return { kind: 'db' };
  if (first.kind !== 'prop') throw unsupported(source);
  let collection: string;
  let i: number;
  if (second?.kind === 'call') {
    if (first.name === 'getCollection') {
      collection = stringArg(parseArgs(second.args, 'getCollection'), 0, 'getCollection');
    } else if ((DATABASE_METHODS as readonly string[]).includes(first.name)) {
      if (steps.length > 2) throw unsupported(source);
      return { kind: 'database', method: first.name as DatabaseMethod, args: parseArgs(second.args, `db.${first.name}`) };
    } else {
      throw unsupported(`db.${first.name}()`);
    }
    i = 2;
  } else {
    collection = first.name;
    i = 1;
  }
  // `db.system.profile.find()` reads the collection `system.profile`.
  for (let step = steps[i]; step?.kind === 'prop' && steps[i + 1]?.kind !== 'call'; step = steps[++i]) collection += `.${step.name}`;
  const methodStep = steps[i];
  const callStep = steps[i + 1];
  if (!methodStep) return { kind: 'namespace', collection };
  if (methodStep.kind !== 'prop' || callStep?.kind !== 'call') throw unsupported(source);
  if (!Object.hasOwn(COLLECTION_METHODS, methodStep.name)) throw unsupported(`db.${collection}.${methodStep.name}()`);
  const method = methodStep.name as CollectionMethod;
  const args = parseArgs(callStep.args, method);
  const cursor: CursorCall[] = [];
  const allowed = CURSOR_METHODS[method] ?? [];
  for (i += 2; i < steps.length; i += 2) {
    const name = steps[i];
    const call = steps[i + 1];
    if (name?.kind !== 'prop' || call?.kind !== 'call') throw unsupported(source);
    if (!allowed.includes(name.name)) throw unsupported(`.${name.name}() after ${method}()`);
    if (cursor.some((c) => c.method === 'count' || c.method === 'explain')) throw unsupported(`.${name.name}() after .${cursor.at(-1)!.method}()`);
    cursor.push({ method: name.name, args: parseArgs(call.args, name.name) });
  }
  return { kind: 'collection', collection, method, args, cursor };
}

function parseLine(line: string): { command: ShellCommand; text: string } {
  const text = line.trim().replace(/;+$/, '').trim();
  if (!text) throw new Error('Type a command, e.g. db.orders.find({ status: "A" }).');
  const show = /^show\s+(\S+)$/.exec(text);
  if (show) {
    const what = show[1]!.toLowerCase();
    if (what === 'dbs' || what === 'databases') return { command: { kind: 'showDatabases' }, text };
    if (what === 'collections' || what === 'tables') return { command: { kind: 'showCollections' }, text };
    throw unsupported(text);
  }
  const use = /^use\s+(\S+)$/.exec(text);
  if (use) return { command: { kind: 'use', database: use[1]! }, text };

  let program;
  try {
    program = parseJs(text, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (error) {
    throw new Error(`SyntaxError: ${(error as Error).message}`);
  }
  const [statement, ...more] = program.body;
  if (!statement || more.length || statement.type !== 'ExpressionStatement') throw unsupported(text);
  return { command: interpret(flatten(statement.expression, text), text), text };
}

/** The command name of a `runCommand` argument: a document's first key or a string. */
function commandDocument(arg: unknown): Document {
  if (typeof arg === 'string') return { [arg]: 1 };
  if (isDocument(arg) && Object.keys(arg).length) return arg;
  throw new Error('runCommand() needs a command document, e.g. { ping: 1 }.');
}

function writes(command: ShellCommand): boolean {
  switch (command.kind) {
    case 'database':
      if (command.method === 'createCollection' || command.method === 'dropDatabase') return true;
      if (command.method === 'runCommand' || command.method === 'adminCommand') {
        const document = commandDocument(command.args[0]);
        const name = Object.keys(document)[0]!;
        if (!READ_COMMANDS.has(name.toLowerCase())) return true;
        return name.toLowerCase() === 'aggregate' && Array.isArray(document.pipeline) && writingStage(document.pipeline) !== null;
      }
      return false;
    case 'collection':
      if (COLLECTION_METHODS[command.method]) return true;
      return command.method === 'aggregate' && writingStage(pipelineArgs(command.args).pipeline) !== null;
    default:
      return false;
  }
}

/** `aggregate([stages], options)` or `aggregate(stage, stage, …)`. */
function pipelineArgs(args: unknown[]): { pipeline: Document[]; options: Document } {
  if (Array.isArray(args[0])) return { pipeline: args[0] as Document[], options: isDocument(args[1]) ? args[1] : {} };
  return { pipeline: args.filter(isDocument), options: {} };
}

export function planShellLine(_database: string, line: string): MongoShellPlan {
  const { command, text } = parseLine(line);
  return { writes: writes(command), description: text };
}

/** Top-level strings print without quotes, like mongosh. */
function print(value: unknown): string {
  return typeof value === 'string' ? value : shellPrint(value);
}

function printDocuments(documents: readonly unknown[]): string {
  if (!documents.length) return '[]';
  return `[\n${documents.map((d) => shellPrint(d).replace(/^/gm, '  ')).join(',\n')}\n]`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(2) : value} ${units[unit]}`;
}

const asOptions = (value: unknown): Document => (isDocument(value) ? value : {});
const filterArg = (value: unknown): Document => {
  if (value === undefined) return {};
  if (!isDocument(value)) throw new Error('The filter must be a document, e.g. { status: "A" }.');
  return value;
};

async function runFind(target: Collection, args: unknown[], cursorCalls: CursorCall[]): Promise<string> {
  const filter = filterArg(args[0]);
  const options: Document = { ...asOptions(args[2]), maxTimeMS: QUERY_TIME_MS };
  if (isDocument(args[1])) options.projection = args[1];
  for (const call of cursorCalls) {
    if (call.method === 'sort') options.sort = call.args[0];
    if (call.method === 'limit') options.limit = Number(call.args[0]) || 0;
    if (call.method === 'skip') options.skip = Number(call.args[0]) || 0;
  }
  const last = cursorCalls.at(-1)?.method;
  if (last === 'count') return print(await target.countDocuments(filter, { maxTimeMS: QUERY_TIME_MS }));
  if (last === 'explain') {
    const verbosity = cursorCalls.at(-1)!.args[0];
    return shellText(await target.find(filter, options).explain(typeof verbosity === 'string' ? verbosity : 'queryPlanner'));
  }
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 0;
  const shown = limit ? Math.min(limit, SHELL_MAX) : SHELL_BATCH;
  // One document more than shown tells whether there are more, unless the limit already ends the cursor there.
  const fetch = limit && limit <= SHELL_MAX ? limit : shown + 1;
  const documents = await target.find(filter, { ...options, ...EXACT, limit: fetch }).toArray();
  if (documents.length <= shown) return printDocuments(documents);
  let more = '';
  try {
    const total = await target.countDocuments(filter, { maxTimeMS: COUNT_TIME_MS, ...(options.skip ? { skip: options.skip } : {}), ...(limit ? { limit } : {}) });
    more = `${total - shown} `;
  } catch {
    // The count is a nicety; a slow one is left out.
  }
  return `${printDocuments(documents.slice(0, shown))}\n… ${more}more (add .limit() or use the Documents tab)`;
}

async function runAggregate(target: Collection, args: unknown[], cursorCalls: CursorCall[]): Promise<string> {
  const { pipeline, options } = pipelineArgs(args);
  const last = cursorCalls.at(-1);
  if (last?.method === 'explain') {
    return shellText(await target.aggregate(pipeline, { ...options, maxTimeMS: QUERY_TIME_MS }).explain(typeof last.args[0] === 'string' ? last.args[0] : 'queryPlanner'));
  }
  // A pipeline that writes has to run to its end; its output is empty anyway.
  const run = writingStage(pipeline) ? pipeline : [...pipeline, { $limit: SHELL_BATCH + 1 }];
  const documents = await target.aggregate(run, { maxTimeMS: QUERY_TIME_MS, ...options, ...EXACT }).toArray();
  if (documents.length <= SHELL_BATCH) return printDocuments(documents);
  return `${printDocuments(documents.slice(0, SHELL_BATCH))}\n… more (add a $limit stage or use the Documents tab)`;
}

function updateResult(result: { acknowledged: boolean; upsertedId: unknown; matchedCount: number; modifiedCount: number; upsertedCount: number }): Document {
  return {
    acknowledged: result.acknowledged,
    insertedId: result.upsertedId ?? null,
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    upsertedCount: result.upsertedCount,
  };
}

async function runCollection(client: MongoClient, database: string, command: Extract<ShellCommand, { kind: 'collection' }>): Promise<string> {
  const db = client.db(database);
  const target = db.collection(command.collection);
  const { args } = command;
  switch (command.method) {
    case 'find':
      return runFind(target, args, command.cursor);
    case 'aggregate':
      return runAggregate(target, args, command.cursor);
    case 'findOne': {
      const options: Document = { ...asOptions(args[2]), ...EXACT, maxTimeMS: QUERY_TIME_MS };
      if (isDocument(args[1])) options.projection = args[1];
      return print(await target.findOne(filterArg(args[0]), options));
    }
    case 'countDocuments':
      return print(await target.countDocuments(filterArg(args[0]), { maxTimeMS: QUERY_TIME_MS, ...asOptions(args[1]) }));
    case 'estimatedDocumentCount':
      return print(await target.estimatedDocumentCount(asOptions(args[0])));
    case 'distinct':
      return print(await target.distinct(stringArg(args, 0, 'distinct'), filterArg(args[1]), { maxTimeMS: QUERY_TIME_MS, ...asOptions(args[2]), ...EXACT }));
    case 'getIndexes':
      return print(await target.listIndexes().toArray());
    case 'stats':
      return print(await db.command({ collStats: command.collection, ...asOptions(args[0]) }));
    case 'insertOne': {
      if (!isDocument(args[0])) throw new Error('insertOne() needs a document, e.g. { name: "Ada" }.');
      const result = await target.insertOne(args[0], asOptions(args[1]));
      return print({ acknowledged: result.acknowledged, insertedId: result.insertedId });
    }
    case 'insertMany': {
      if (!Array.isArray(args[0]) || !args[0].every(isDocument)) throw new Error('insertMany() needs an array of documents.');
      const result = await target.insertMany(args[0], asOptions(args[1]));
      return print({ acknowledged: result.acknowledged, insertedIds: Object.fromEntries(Object.entries(result.insertedIds)) });
    }
    case 'updateOne':
      return print(updateResult(await target.updateOne(filterArg(args[0]), args[1] as Document, asOptions(args[2]))));
    case 'updateMany':
      return print(updateResult(await target.updateMany(filterArg(args[0]), args[1] as Document, asOptions(args[2]))));
    case 'replaceOne':
      if (!isDocument(args[1])) throw new Error('replaceOne() needs a replacement document as argument 2.');
      return print(updateResult(await target.replaceOne(filterArg(args[0]), args[1], asOptions(args[2]))));
    case 'deleteOne': {
      const result = await target.deleteOne(filterArg(args[0]), asOptions(args[1]));
      return print({ acknowledged: result.acknowledged, deletedCount: result.deletedCount });
    }
    case 'deleteMany': {
      const result = await target.deleteMany(filterArg(args[0]), asOptions(args[1]));
      return print({ acknowledged: result.acknowledged, deletedCount: result.deletedCount });
    }
    case 'findOneAndUpdate':
      return print(await target.findOneAndUpdate(filterArg(args[0]), args[1] as Document, { ...asOptions(args[2]), ...EXACT }));
    case 'findOneAndReplace':
      if (!isDocument(args[1])) throw new Error('findOneAndReplace() needs a replacement document as argument 2.');
      return print(await target.findOneAndReplace(filterArg(args[0]), args[1], { ...asOptions(args[2]), ...EXACT }));
    case 'findOneAndDelete':
      return print(await target.findOneAndDelete(filterArg(args[0]), { ...asOptions(args[1]), ...EXACT }));
    case 'createIndex':
      if (!isDocument(args[0])) throw new Error('createIndex() needs a key pattern, e.g. { email: 1 }.');
      return print(await target.createIndex(args[0], asOptions(args[1])));
    case 'dropIndex':
      if (typeof args[0] !== 'string' && !isDocument(args[0])) throw new Error('dropIndex() needs an index name or key pattern.');
      return print(await db.command({ dropIndexes: command.collection, index: args[0] }));
    case 'dropIndexes':
      return print(await db.command({ dropIndexes: command.collection, index: args[0] ?? '*' }));
    case 'drop':
      return print(await target.drop());
    case 'renameCollection':
      await target.rename(stringArg(args, 0, 'renameCollection'), { dropTarget: args[1] === true });
      return print({ ok: 1 });
  }
}

async function runDatabase(client: MongoClient, database: string, command: Extract<ShellCommand, { kind: 'database' }>): Promise<string> {
  const db = client.db(database);
  const { args } = command;
  switch (command.method) {
    case 'getName':
      return database;
    case 'getCollectionNames': {
      const names = (await db.listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray()).map((c) => c.name);
      return print(names.sort());
    }
    case 'stats':
      return print(await db.command({ dbStats: 1, ...(typeof args[0] === 'number' ? { scale: args[0] } : asOptions(args[0])) }));
    case 'runCommand':
      return print(await db.command(commandDocument(args[0])));
    case 'adminCommand':
      return print(await client.db('admin').command(commandDocument(args[0])));
    case 'createCollection':
      await db.createCollection(stringArg(args, 0, 'createCollection'), asOptions(args[1]));
      return print({ ok: 1 });
    case 'dropDatabase':
      await db.dropDatabase();
      return print({ ok: 1, dropped: database });
  }
}

async function run(client: MongoClient, database: string, command: ShellCommand): Promise<MongoShellResult> {
  switch (command.kind) {
    case 'showDatabases': {
      const databases = (await listDatabases(client)).sort((a, b) => a.name.localeCompare(b.name));
      const width = Math.max(0, ...databases.map((d) => d.name.length));
      return { output: databases.map((d) => `${d.name.padEnd(width)}  ${formatBytes(d.sizeOnDisk)}`.trimEnd()).join('\n'), ok: true, database };
    }
    case 'showCollections': {
      const infos = await client.db(database).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
      return { output: visibleCollections(infos).map((c) => c.name).sort().join('\n'), ok: true, database };
    }
    case 'use':
      // The driver checks the name.
      client.db(command.database);
      return { output: `switched to db ${command.database}`, ok: true, database: command.database };
    case 'db':
      return { output: database, ok: true, database };
    case 'namespace':
      return { output: `${database}.${command.collection}`, ok: true, database };
    case 'database':
      return { output: await runDatabase(client, database, command), ok: true, database };
    case 'collection':
      return { output: await runCollection(client, database, command), ok: true, database };
  }
}

/** `MongoServerError: …` as mongosh prints errors; messages of this shell print as they are. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message;
}

export async function runShellLine(client: MongoClient, database: string, line: string): Promise<MongoShellResult> {
  try {
    return await run(client, database, parseLine(line).command);
  } catch (error) {
    return { output: errorText(error), ok: false, database };
  }
}
