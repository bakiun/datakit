import type {
  CheckInfo,
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  ObjectKind,
  ObjectMatch,
  PgObjectKind,
  PgSchemaObjects,
  ReferentialAction,
  TableStructure,
} from '@datakit/core';

/**
 * Reads tables, views and routines from the system catalogs. Every function takes `query`, which runs a statement
 * with pg's own type parsing, so arrays and JSON arrive as JavaScript values.
 */
export type Query = <T>(sql: string, values?: unknown[]) => Promise<T[]>;

/** Leaves out objects an extension created, such as the functions and types of pgcrypto or hstore. */
const NOT_FROM_EXTENSION = (oid: string, catalog: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = ${oid} AND d.classid = '${catalog}'::regclass AND d.deptype = 'e')`;

/** Row estimate from the statistics; PostgreSQL reports -1 for a table that was never analyzed. */
const estimate = (value: unknown) => (value === null || value === undefined || Number(value) < 0 ? null : Math.round(Number(value)));

export async function listSchemaObjects(query: Query, schema: string): Promise<PgSchemaObjects> {
  // Partitions are left out; their partitioned table stands for them.
  const relations = await query<{ name: string; kind: string; estimate: number }>(
    `SELECT c.relname AS name, c.relkind AS kind, c.reltuples AS estimate
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S') AND NOT c.relispartition
        AND ${NOT_FROM_EXTENSION('c.oid', 'pg_class')}
      ORDER BY c.relname`,
    [schema],
  );
  const routines = await query<{ name: string; kind: string; args: string }>(
    `SELECT p.proname AS name, p.prokind AS kind, pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') AND ${NOT_FROM_EXTENSION('p.oid', 'pg_proc')}
      ORDER BY 1, 3`,
    [schema],
  );
  // Enums, domains, ranges and composite types made with CREATE TYPE; not the row types of tables.
  const types = await query<{ name: string; kind: string }>(
    `SELECT t.typname AS name, t.typtype AS kind
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1
        AND (t.typtype IN ('e', 'd', 'r') OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))
        AND ${NOT_FROM_EXTENSION('t.oid', 'pg_type')}
      ORDER BY 1`,
    [schema],
  );
  const of = (...kinds: string[]) => relations.filter((r) => kinds.includes(r.kind));
  const TYPE_KINDS: Record<string, PgSchemaObjects['types'][number]['kind']> = { e: 'enum', d: 'domain', r: 'range', c: 'composite' };
  return {
    tables: of('r', 'p', 'f').map((r) => ({ name: r.name, rows: r.kind === 'p' ? null : estimate(r.estimate) })),
    views: of('v').map((r) => r.name),
    materializedViews: of('m').map((r) => ({ name: r.name, rows: estimate(r.estimate) })),
    sequences: of('S').map((r) => r.name),
    functions: routines.filter((r) => r.kind === 'f').map(({ name, args }) => ({ name, args })),
    procedures: routines.filter((r) => r.kind === 'p').map(({ name, args }) => ({ name, args })),
    types: types.map((t) => ({ name: t.name, kind: TYPE_KINDS[t.kind]! })),
  };
}

const KIND_OF_RELATION: Record<string, ObjectKind> = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'materializedView' };

/** Tables, views and routines of every schema of the database whose name contains `text`; system schemas come last. */
export async function searchObjects(query: Query, database: string, text: string, limit: number): Promise<ObjectMatch[]> {
  const pattern = `%${text.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;
  const rows = await query<{ schema: string; name: string; kind: string; estimate: number | null }>(
    `SELECT * FROM (
       SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind, c.reltuples AS estimate
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm') AND NOT c.relispartition AND lower(c.relname) LIKE $1 ESCAPE '!'
       UNION ALL
       SELECT DISTINCT n.nspname, p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, NULL::real
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'p') AND lower(p.proname) LIKE $1 ESCAPE '!'
     ) found
     WHERE schema !~ '^pg_(toast|temp_)'
     ORDER BY schema IN ('pg_catalog', 'information_schema'), schema, name
     LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((r) => ({
    database,
    schema: r.schema,
    // Routines are named in full: prokind's `f` and `p` are relkind's foreign and partitioned tables.
    kind: KIND_OF_RELATION[r.kind] ?? (r.kind === 'procedure' ? 'procedure' : 'function'),
    name: r.name,
    rows: r.kind === 'r' ? estimate(r.estimate) : null,
  }));
}

interface ColumnRow {
  name: string;
  column_type: string;
  type_name: string;
  type_type: string;
  category: string;
  element_name: string | null;
  base_oid: string;
  not_null: boolean;
  default_expr: string | null;
  identity: string;
  generated: string;
  comment: string | null;
  collation: string | null;
}

interface IndexRow {
  name: string;
  primary: boolean;
  unique: boolean;
  method: string;
  definition: string;
  constraint: boolean;
  partial: boolean;
  columns: string[];
  /** Whether each key column is a column of the table rather than an expression. */
  plain: boolean[];
}

const ACTIONS: Record<string, ReferentialAction> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

/** The oid and kind of a table, view or materialized view. */
async function relation(query: Query, schema: string, name: string): Promise<{ oid: string; kind: string; persistence: string } | undefined> {
  const [row] = await query<{ oid: string; kind: string; persistence: string }>(
    `SELECT c.oid::text AS oid, c.relkind AS kind, c.relpersistence AS persistence
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')`,
    [schema, name],
  );
  return row;
}

export async function describeTable(query: Query, database: string, schema: string, table: string): Promise<TableStructure> {
  const rel = await relation(query, schema, table);
  if (!rel) throw new Error(`Table “${schema}.${table}” does not exist.`);
  const rows = await query<ColumnRow>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS column_type, t.typname AS type_name,
            COALESCE(bt.typtype, t.typtype) AS type_type, COALESCE(bt.typcategory, t.typcategory) AS category,
            e.typname AS element_name, COALESCE(bt.oid, t.oid)::text AS base_oid, a.attnotnull AS not_null,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr, a.attidentity AS identity, a.attgenerated AS generated,
            col_description(a.attrelid, a.attnum) AS comment,
            CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_type bt ON bt.oid = t.typbasetype AND t.typtype = 'd'
       LEFT JOIN pg_type e ON e.oid = t.typelem AND t.typcategory = 'A'
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [rel.oid],
  );
  const enumOids = rows.filter((r) => r.type_type === 'e').map((r) => r.base_oid);
  const labels = new Map<string, string[]>();
  if (enumOids.length) {
    for (const r of await query<{ oid: string; labels: string[] }>(
      `SELECT enumtypid::text AS oid, json_agg(enumlabel ORDER BY enumsortorder) AS labels FROM pg_enum WHERE enumtypid = ANY($1::oid[]) GROUP BY enumtypid`,
      [enumOids],
    )) {
      labels.set(r.oid, r.labels);
    }
  }

  const indexRows = await query<IndexRow>(
    `SELECT ic.relname AS name, i.indisprimary AS primary, i.indisunique AS unique, am.amname AS method,
            pg_get_indexdef(i.indexrelid) AS definition, i.indpred IS NOT NULL AS partial,
            EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid AND c.contype IN ('p', 'u', 'x')) AS constraint,
            (SELECT json_agg(CASE WHEN i.indkey[k] = 0 THEN pg_get_indexdef(i.indexrelid, k + 1, true)
                                  ELSE (SELECT attname FROM pg_attribute WHERE attrelid = i.indrelid AND attnum = i.indkey[k]) END ORDER BY k)
               FROM generate_series(0, i.indnkeyatts - 1) k) AS columns,
            (SELECT json_agg(i.indkey[k] <> 0 ORDER BY k) FROM generate_series(0, i.indnkeyatts - 1) k) AS plain
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1
      ORDER BY i.indisprimary DESC, ic.relname`,
    [rel.oid],
  );
  const indexes: IndexInfo[] = indexRows.map((r) => ({
    name: r.name,
    kind: r.primary ? 'PRIMARY' : r.unique ? 'UNIQUE' : 'INDEX',
    unique: r.unique,
    columns: r.columns,
    lengths: r.columns.map(() => null),
    constraint: r.constraint,
    method: r.method,
    definition: r.definition,
  }));

  const notNull = (name: string) => rows.find((c) => c.name === name)?.not_null === true;
  const primary = indexRows.find((r) => r.primary);
  // Without a primary key, a unique index on NOT NULL columns identifies rows; not one with a condition or expressions.
  const key = primary ?? indexRows.find((r) => r.unique && !r.partial && r.plain.every(Boolean) && r.columns.every(notNull));
  const keyOf = (name: string): string => {
    if (primary?.columns.includes(name)) return 'PRI';
    if (indexRows.some((r) => r.unique && r.columns.length === 1 && r.columns[0] === name && r.plain[0])) return 'UNI';
    if (indexRows.some((r) => r.columns[0] === name && r.plain[0])) return 'MUL';
    return '';
  };

  const columns: ColumnInfo[] = rows.map((r) => {
    const identity = r.identity === 'a' ? 'always' : r.identity === 'd' ? 'by default' : null;
    const stored = r.generated === 's';
    const sequence = /^nextval\(/i.test(r.default_expr ?? '');
    const extra = identity ? `GENERATED ${identity.toUpperCase()} AS IDENTITY` : stored ? `GENERATED ALWAYS AS (${r.default_expr}) STORED` : '';
    return {
      name: r.name,
      columnType: r.column_type,
      dataType: r.element_name ? `${r.element_name}[]` : r.type_name,
      nullable: !r.not_null,
      defaultValue: stored ? null : r.default_expr,
      key: keyOf(r.name),
      extra,
      autoIncrement: identity !== null || sequence,
      // GENERATED ALWAYS identities take no values either, unless a statement says OVERRIDING SYSTEM VALUE.
      generated: stored || identity === 'always',
      numeric: r.category === 'N',
      binary: r.type_name === 'bytea',
      enumValues: r.type_type === 'e' ? (labels.get(r.base_oid) ?? null) : r.category === 'B' && !r.element_name ? ['true', 'false'] : null,
      defaultSql: stored ? null : r.default_expr,
      comment: r.comment ?? '',
      charset: null,
      collation: r.collation,
      onUpdate: null,
      generation: stored ? { expression: r.default_expr ?? '', stored: true } : null,
      check: null,
      identity,
    };
  });

  const foreignKeys: ForeignKeyInfo[] = (
    await query<{ name: string; on_update: string; on_delete: string; ref_schema: string; ref_table: string; columns: string[]; ref_columns: string[] }>(
      `SELECT c.conname AS name, c.confupdtype AS on_update, c.confdeltype AS on_delete, rn.nspname AS ref_schema, rc.relname AS ref_table,
              (SELECT json_agg(a.attname ORDER BY k.i) FROM unnest(c.conkey) WITH ORDINALITY k(num, i)
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num) AS columns,
              (SELECT json_agg(a.attname ORDER BY k.i) FROM unnest(c.confkey) WITH ORDINALITY k(num, i)
                 JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num) AS ref_columns
         FROM pg_constraint c JOIN pg_class rc ON rc.oid = c.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE c.conrelid = $1 AND c.contype = 'f'
        ORDER BY c.conname`,
      [rel.oid],
    )
  ).map((r) => ({
    name: r.name,
    columns: r.columns,
    refDatabase: database,
    refSchema: r.ref_schema,
    refTable: r.ref_table,
    refColumns: r.ref_columns,
    onUpdate: ACTIONS[r.on_update] ?? 'NO ACTION',
    onDelete: ACTIONS[r.on_delete] ?? 'NO ACTION',
  }));

  const checks: CheckInfo[] = (
    await query<{ name: string; definition: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid, true) AS definition FROM pg_constraint WHERE conrelid = $1 AND contype = 'c' ORDER BY conname`,
      [rel.oid],
    )
  ).map((r) => ({ name: r.name, clause: /^CHECK \((.*)\)(?: NO INHERIT)?(?: NOT VALID)?$/s.exec(r.definition)?.[1] ?? r.definition }));

  return {
    dialect: 'postgres',
    database,
    schema,
    table,
    kind: rel.kind === 'v' ? 'view' : rel.kind === 'm' ? 'materializedView' : 'table',
    options: null,
    checks,
    columns,
    indexes,
    foreignKeys,
    rowKey: key ? [...key.columns] : [],
  };
}

/** `pg_get_viewdef` ends the query with a semicolon; the statements here leave it to the caller. */
const withoutSemicolon = (sql: string) => sql.trim().replace(/;$/, '');

async function quoted(query: Query, schema: string, name: string): Promise<string> {
  const [row] = await query<{ name: string }>(`SELECT quote_ident($1) || '.' || quote_ident($2) AS name`, [schema, name]);
  return row!.name;
}

async function commentStatements(query: Query, oid: string, target: string, kind: string): Promise<string[]> {
  const rows = await query<{ column: string | null; comment: string }>(
    `SELECT CASE WHEN objsubid = 0 THEN NULL ELSE quote_ident((SELECT attname FROM pg_attribute WHERE attrelid = objoid AND attnum = objsubid)) END AS column,
            quote_literal(description) AS comment
       FROM pg_description WHERE objoid = $1 AND classoid = 'pg_class'::regclass ORDER BY objsubid`,
    [oid],
  );
  return rows.map((r) => (r.column ? `COMMENT ON COLUMN ${target}.${r.column} IS ${r.comment}` : `COMMENT ON ${kind} ${target} IS ${r.comment}`));
}

/** CREATE TABLE with columns and constraints, then the indexes that no constraint creates, then comments. */
async function tableDefinition(query: Query, rel: { oid: string; kind: string; persistence: string }, target: string): Promise<string> {
  const columns = await query<{ line: string }>(
    `SELECT quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
              || CASE WHEN a.attcollation <> t.typcollation THEN ' COLLATE ' || quote_ident(co.collname) ELSE '' END
              || CASE a.attidentity WHEN 'a' THEN ' GENERATED ALWAYS AS IDENTITY' WHEN 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' ELSE '' END
              || CASE WHEN a.attgenerated = 's' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ') STORED'
                      WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END
              || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END AS line
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [rel.oid],
  );
  // NOT NULL is part of the columns; PostgreSQL 18 also lists it as a constraint.
  const constraints = await query<{ line: string }>(
    `SELECT 'CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid, true) AS line
       FROM pg_constraint WHERE conrelid = $1 AND contype IN ('p', 'u', 'f', 'c', 'x')
      ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'x' THEN 3 ELSE 4 END, conname`,
    [rel.oid],
  );
  const [extra] = await query<{ partition_by: string | null; server: string | null }>(
    `SELECT CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_by,
            (SELECT quote_ident(s.srvname) FROM pg_foreign_table ft JOIN pg_foreign_server s ON s.oid = ft.ftserver WHERE ft.ftrelid = c.oid) AS server
       FROM pg_class c WHERE c.oid = $1`,
    [rel.oid],
  );
  const indexes = await query<{ definition: string }>(
    `SELECT pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
      WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid AND c.conrelid = i.indrelid)
      ORDER BY 1`,
    [rel.oid],
  );
  const kind = rel.kind === 'f' ? 'FOREIGN TABLE' : rel.persistence === 'u' ? 'UNLOGGED TABLE' : 'TABLE';
  const lines = [...columns, ...constraints].map((r) => `    ${r.line}`).join(',\n');
  let create = `CREATE ${kind} ${target} (\n${lines}\n)`;
  if (extra?.partition_by) create += `\nPARTITION BY ${extra.partition_by}`;
  if (extra?.server) create += `\nSERVER ${extra.server}`;
  const comments = await commentStatements(query, rel.oid, target, rel.kind === 'f' ? 'FOREIGN TABLE' : 'TABLE');
  return [create, ...indexes.map((i) => i.definition), ...comments].join(';\n\n');
}

async function viewDefinition(query: Query, rel: { oid: string; kind: string }, target: string): Promise<string> {
  const [view] = await query<{ definition: string }>(`SELECT pg_get_viewdef($1::oid, true) AS definition`, [rel.oid]);
  const body = withoutSemicolon(view?.definition ?? '');
  if (rel.kind === 'v') {
    return [`CREATE OR REPLACE VIEW ${target} AS\n${body}`, ...(await commentStatements(query, rel.oid, target, 'VIEW'))].join(';\n\n');
  }
  const indexes = await query<{ definition: string }>(`SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid = $1 ORDER BY 1`, [rel.oid]);
  return [
    `CREATE MATERIALIZED VIEW ${target} AS\n${body}\nWITH DATA`,
    ...indexes.map((i) => i.definition),
    ...(await commentStatements(query, rel.oid, target, 'MATERIALIZED VIEW')),
  ].join(';\n\n');
}

async function routineDefinition(query: Query, schema: string, name: string, args: string | undefined): Promise<string> {
  const rows = await query<{ definition: string }>(
    `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 AND ($3::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $3)
      ORDER BY pg_get_function_identity_arguments(p.oid)`,
    [schema, name, args ?? null],
  );
  if (!rows.length) throw new Error(`Routine “${schema}.${name}” does not exist.`);
  return rows.map((r) => withoutSemicolon(r.definition)).join(';\n\n');
}

async function sequenceDefinition(query: Query, schema: string, name: string, target: string): Promise<string> {
  const [row] = await query<{ line: string; owned_by: string | null }>(
    `SELECT 'AS ' || format_type(s.seqtypid, NULL) || ' INCREMENT BY ' || s.seqincrement || ' MINVALUE ' || s.seqmin
              || ' MAXVALUE ' || s.seqmax || ' START WITH ' || s.seqstart || ' CACHE ' || s.seqcache
              || CASE WHEN s.seqcycle THEN ' CYCLE' ELSE ' NO CYCLE' END AS line,
            (SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname) || '.' || quote_ident(a.attname)
               FROM pg_depend d JOIN pg_class t ON t.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = t.relnamespace
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
              LIMIT 1) AS owned_by
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  if (!row) throw new Error(`Sequence “${schema}.${name}” does not exist.`);
  return `CREATE SEQUENCE ${target}\n    ${row.line}${row.owned_by ? `\n    OWNED BY ${row.owned_by}` : ''}`;
}

async function typeDefinition(query: Query, schema: string, name: string, target: string): Promise<string> {
  const [type] = await query<{ oid: string; kind: string; base: string | null; not_null: boolean; default_expr: string | null; relid: string; subtype: string | null }>(
    `SELECT t.oid::text AS oid, t.typtype AS kind, format_type(t.typbasetype, t.typtypmod) AS base, t.typnotnull AS not_null,
            t.typdefault AS default_expr, t.typrelid::text AS relid,
            (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid) AS subtype
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typname = $2`,
    [schema, name],
  );
  if (!type) throw new Error(`Type “${schema}.${name}” does not exist.`);
  switch (type.kind) {
    case 'e': {
      const [row] = await query<{ labels: string }>(
        `SELECT string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) AS labels FROM pg_enum WHERE enumtypid = $1`,
        [type.oid],
      );
      return `CREATE TYPE ${target} AS ENUM (${row?.labels ?? ''})`;
    }
    case 'd': {
      const checks = await query<{ line: string }>(
        `SELECT 'CONSTRAINT ' || quote_ident(conname) || ' ' || pg_get_constraintdef(oid, true) AS line FROM pg_constraint WHERE contypid = $1 AND contype = 'c' ORDER BY conname`,
        [type.oid],
      );
      const parts = [`CREATE DOMAIN ${target} AS ${type.base}`];
      if (type.default_expr) parts.push(`DEFAULT ${type.default_expr}`);
      if (type.not_null) parts.push('NOT NULL');
      parts.push(...checks.map((c) => c.line));
      return parts.join('\n    ');
    }
    case 'r':
      return `CREATE TYPE ${target} AS RANGE (SUBTYPE = ${type.subtype})`;
    default: {
      const attributes = await query<{ line: string }>(
        `SELECT quote_ident(attname) || ' ' || format_type(atttypid, atttypmod) AS line FROM pg_attribute WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
        [type.relid],
      );
      return `CREATE TYPE ${target} AS (\n${attributes.map((a) => `    ${a.line}`).join(',\n')}\n)`;
    }
  }
}

/** The CREATE statements of an object, without a closing semicolon. */
export async function definition(query: Query, schema: string, name: string, kind: PgObjectKind, args?: string): Promise<string> {
  if (kind === 'function' || kind === 'procedure') return routineDefinition(query, schema, name, args);
  const target = await quoted(query, schema, name);
  if (kind === 'sequence') return sequenceDefinition(query, schema, name, target);
  if (kind === 'type') return typeDefinition(query, schema, name, target);
  const rel = await relation(query, schema, name);
  if (!rel) throw new Error(`“${schema}.${name}” does not exist.`);
  return rel.kind === 'v' || rel.kind === 'm' ? viewDefinition(query, rel, target) : tableDefinition(query, rel, target);
}
