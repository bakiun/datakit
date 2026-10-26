import type { SqlSession, StatementResult, TableInfo } from '../sql/session';

/**
 * What a PostgreSQL session offers beyond the shared SQL contract. A session is bound to one database; its tables,
 * views and routines are in schemas, which take the place of MySQL's databases in the SQL contract.
 */

/** Objects of a schema, as the tree lists them. */
export type PgObjectKind = 'table' | 'view' | 'materializedView' | 'sequence' | 'function' | 'procedure' | 'type';

export interface PgRoutineInfo {
  name: string;
  /** The argument types, e.g. `integer, text`; they tell overloads apart. */
  args: string;
}

export interface PgTypeInfo {
  name: string;
  kind: 'enum' | 'domain' | 'composite' | 'range';
}

export interface PgSchemaObjects {
  tables: TableInfo[];
  views: string[];
  materializedViews: TableInfo[];
  sequences: string[];
  functions: PgRoutineInfo[];
  procedures: PgRoutineInfo[];
  types: PgTypeInfo[];
}

export interface PostgresSession extends SqlSession {
  readonly dialect: 'postgres';
  /** The database the session is connected to. */
  readonly database: string;
  /** Schemas of the database, in the order the tree lists them (see `orderSchemas`). */
  listSchemas(): Promise<string[]>;
  listSchemaObjects(schema: string): Promise<PgSchemaObjects>;
  /** The CREATE statement of an object; `args` picks an overload of a function or procedure. */
  definition(schema: string, name: string, kind: PgObjectKind, args?: string): Promise<string>;
  /** The schema that unqualified names resolve to first; null when the search path names none that exists. */
  currentSchema(): Promise<string | null>;
  /** Puts `schema` first in the search path, followed by `public`. */
  setSchema(schema: string): Promise<void>;
  /**
   * The plan of a statement as text, one line per row. `analyze` runs the statement to measure it, inside a
   * transaction (or savepoint) that is rolled back afterwards.
   */
  explain(statement: string, analyze: boolean): Promise<StatementResult>;
}

export function isPostgresSession(session: SqlSession): session is PostgresSession {
  return session.dialect === 'postgres';
}

/** Schemas PostgreSQL keeps for itself; they are listed last. */
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

/** TOAST and temporary schemas hold nothing to browse. */
export function isHiddenSchema(name: string): boolean {
  return /^pg_(toast|temp_\d+|toast_temp_\d+)$/.test(name);
}

export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMAS.has(name);
}

/** `public` first, then the user's schemas by name, then `pg_catalog` and `information_schema`; TOAST and temporary ones are left out. */
export function orderSchemas(names: readonly string[]): string[] {
  const rank = (name: string) => (name === 'public' ? 0 : isSystemSchema(name) ? 2 : 1);
  return names.filter((name) => !isHiddenSchema(name)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The database a data source connects to first, the others by name. */
export function orderDatabases(names: readonly string[], first: string): string[] {
  const rank = (name: string) => (name === first ? 0 : 1);
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
