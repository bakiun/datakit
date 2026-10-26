import { describe, expect, it } from 'vitest';
import {
  buildAlterTable,
  buildChanges,
  buildConnectionUrl,
  buildCount,
  buildSelect,
  countDraftChanges,
  createDataSourceSettings,
  draftOf,
  isSimpleIndex,
  orderDatabases,
  orderSchemas,
  parseConnectionUrl,
  pgQuoteString,
  quoteIdentifier,
  readOnlyReason,
  validateDataSource,
  validateDraft,
  type ColumnInfo,
  type DataSourceSettings,
  type StructureDraft,
  type TableStructure,
} from '../src';

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    columnType: 'text',
    dataType: 'text',
    nullable: true,
    defaultValue: null,
    key: '',
    extra: '',
    autoIncrement: false,
    generated: false,
    numeric: false,
    binary: false,
    enumValues: null,
    defaultSql: null,
    comment: '',
    charset: null,
    collation: null,
    onUpdate: null,
    generation: null,
    check: null,
    identity: null,
    ...patch,
  };
}

const orders: TableStructure = {
  dialect: 'postgres',
  database: 'shop',
  schema: 'public',
  table: 'orders',
  kind: 'table',
  options: null,
  checks: [{ name: 'orders_total_check', clause: '(total >= 0::numeric)' }],
  columns: [
    column('id', { columnType: 'bigint', dataType: 'int8', nullable: false, key: 'PRI', autoIncrement: true, identity: 'by default', numeric: true }),
    column('status', { columnType: 'order_status', dataType: 'order_status', nullable: false, defaultValue: "'pending'::order_status", defaultSql: "'pending'::order_status", enumValues: ['pending', 'paid'] }),
    column('total', { columnType: 'numeric(12,2)', dataType: 'numeric', nullable: false, numeric: true }),
    column('Note Text', { comment: 'free text' }),
    column('customer_id', { columnType: 'integer', dataType: 'int4', numeric: true }),
  ],
  indexes: [
    { name: 'orders_pkey', kind: 'PRIMARY', unique: true, columns: ['id'], lengths: [null], constraint: true, method: 'btree', definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)' },
    { name: 'orders_status_idx', kind: 'INDEX', unique: false, columns: ['status', 'Note Text'], lengths: [null, null], constraint: false, method: 'btree', definition: 'CREATE INDEX orders_status_idx ON public.orders USING btree (status, "Note Text")' },
    { name: 'orders_lower_idx', kind: 'INDEX', unique: false, columns: ['lower("Note Text")'], lengths: [null], constraint: false, method: 'btree', definition: 'CREATE INDEX orders_lower_idx ON public.orders USING btree (lower("Note Text"))' },
  ],
  foreignKeys: [
    { name: 'orders_customer_id_fkey', columns: ['customer_id'], refDatabase: 'shop', refSchema: 'public', refTable: 'customers', refColumns: ['id'], onUpdate: 'NO ACTION', onDelete: 'SET DEFAULT' },
  ],
  rowKey: ['id'],
};

function edit(change: (d: StructureDraft) => void): StructureDraft {
  const draft = draftOf(orders);
  change(draft);
  return draft;
}

describe('PostgreSQL table SQL', () => {
  it('quotes identifiers with double quotes and pages with LIMIT and OFFSET', () => {
    expect(quoteIdentifier('we"ird', 'postgres')).toBe('"we""ird"');
    expect(buildSelect(orders, { where: "status = 'paid'", sort: [{ column: 'total', direction: 'desc' }], limit: 25, offset: 50 })).toBe(
      'SELECT *\nFROM "public"."orders"\nWHERE status = \'paid\'\nORDER BY "total" DESC\nLIMIT 25 OFFSET 50;',
    );
    expect(buildCount(orders, '')).toBe('SELECT COUNT(*) AS total FROM "public"."orders"');
  });

  it('numbers parameters and leaves LIMIT out of UPDATE and DELETE', () => {
    const statements = buildChanges(
      orders,
      [
        { kind: 'update', row: 0, values: { status: 'paid', total: '12.50' } },
        { kind: 'insert', values: { status: 'pending', total: '1' } },
        { kind: 'insert', values: {} },
        { kind: 'delete', row: 1 },
      ],
      (row) => [String(row + 10)],
    );
    expect(statements).toEqual([
      { sql: 'UPDATE "public"."orders" SET "status" = $1, "total" = $2 WHERE "id" = $3', params: ['paid', '12.50', '10'], expectedRows: 1 },
      { sql: 'INSERT INTO "public"."orders" ("status", "total") VALUES ($1, $2)', params: ['pending', '1'] },
      { sql: 'INSERT INTO "public"."orders" DEFAULT VALUES', params: [] },
      { sql: 'DELETE FROM "public"."orders" WHERE "id" = $1', params: ['11'], expectedRows: 1 },
    ]);
  });

  it('explains why materialized views are read-only', () => {
    expect(readOnlyReason({ ...orders, kind: 'materializedView' })).toMatch(/^Materialized views are read-only/);
  });

  it('writes string literals that survive any standard_conforming_strings', () => {
    expect(pgQuoteString("it's")).toBe("'it''s'");
    expect(pgQuoteString('C:\\temp')).toBe("E'C:\\\\temp'");
  });
});

describe('PostgreSQL structure changes', () => {
  it('starts from a draft without table options, with identity as the auto-numbering flag', () => {
    const draft = draftOf(orders);
    expect(draft.table).toBeNull();
    expect(draft.columns[0]).toMatchObject({ autoIncrement: true, defaultSql: '' });
    expect(draft.indexes.map((i) => i.columns)).toEqual(['id', 'status, "Note Text"', 'lower("Note Text")']);
    expect(draft.foreignKeys[0]?.refTable).toBe('customers');
    expect(buildAlterTable(orders, draft)).toEqual([]);
    expect(countDraftChanges(orders, draft)).toBe(0);
    expect(validateDraft(orders, draft)).toEqual({});
  });

  it('changes type, default, NULL, identity and comment one clause at a time', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.columns[2]!.type = 'numeric(14,2)';
        d.columns[2]!.defaultSql = '0';
        d.columns[1]!.nullable = true;
        d.columns[0]!.autoIncrement = false;
        d.columns[4]!.autoIncrement = true;
        d.columns[4]!.nullable = false;
        d.columns[3]!.comment = "Customer's note";
      }),
    );
    expect(sql).toEqual([
      'ALTER TABLE "public"."orders"\n' +
        '  ALTER COLUMN "id" DROP IDENTITY,\n' +
        '  ALTER COLUMN "status" DROP NOT NULL,\n' +
        '  ALTER COLUMN "total" TYPE numeric(14,2) USING "total"::numeric(14,2),\n' +
        '  ALTER COLUMN "total" SET DEFAULT 0,\n' +
        '  ALTER COLUMN "customer_id" SET NOT NULL,\n' +
        '  ALTER COLUMN "customer_id" ADD GENERATED BY DEFAULT AS IDENTITY',
      'COMMENT ON COLUMN "public"."orders"."Note Text" IS \'Customer\'\'s note\'',
    ]);
  });

  it('renames, adds and drops columns, indexes and constraints in an order PostgreSQL accepts', () => {
    const draft = edit((d) => {
      d.columns[3]!.name = 'note';
      d.indexes[1]!.columns = 'status, note'; // as the tab updates it on rename
      d.indexes[1]!.kind = 'UNIQUE';
      d.columns[4]!.dropped = true;
      d.foreignKeys[0]!.dropped = true;
      d.columns.push({ original: null, name: 'placed_at', type: 'timestamptz', nullable: false, defaultSql: 'now()', autoIncrement: false, comment: 'When', dropped: false });
      d.indexes.push({ original: null, kind: 'UNIQUE', name: 'orders_placed_key', columns: 'placed_at, id', dropped: false });
      d.indexes.push({ original: null, kind: 'INDEX', name: 'orders_total_idx', columns: 'total DESC', dropped: false });
      d.checks[0]!.clause = 'total > 0';
    });
    expect(validateDraft(orders, draft)).toEqual({});
    expect(buildAlterTable(orders, draft)).toEqual([
      'DROP INDEX "public"."orders_status_idx"',
      'ALTER TABLE "public"."orders"\n  DROP CONSTRAINT "orders_customer_id_fkey",\n  DROP CONSTRAINT "orders_total_check",\n  DROP COLUMN "customer_id"',
      'ALTER TABLE "public"."orders" RENAME COLUMN "Note Text" TO "note"',
      'ALTER TABLE "public"."orders"\n' +
        '  ADD COLUMN "placed_at" timestamptz NOT NULL DEFAULT now(),\n' +
        '  ADD CONSTRAINT "orders_placed_key" UNIQUE ("placed_at", "id"),\n' +
        '  ADD CONSTRAINT "orders_total_check" CHECK (total > 0)',
      'CREATE UNIQUE INDEX "orders_status_idx" ON "public"."orders" ("status", "note")',
      'CREATE INDEX "orders_total_idx" ON "public"."orders" ("total" DESC)',
      'COMMENT ON COLUMN "public"."orders"."placed_at" IS \'When\'',
    ]);
    expect(countDraftChanges(orders, draft)).toBe(8);
  });

  it('replaces the primary key constraint and foreign keys to other schemas', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.indexes[0]!.columns = 'id, status';
        d.foreignKeys.push({ original: null, name: 'orders_sku_fkey', columns: 'status', refTable: 'inventory.products', refColumns: 'sku', onUpdate: 'CASCADE', onDelete: 'RESTRICT', dropped: false });
      }),
    );
    expect(sql).toEqual([
      'ALTER TABLE "public"."orders"\n  DROP CONSTRAINT "orders_pkey"',
      'ALTER TABLE "public"."orders"\n' +
        '  ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id", "status"),\n' +
        '  ADD CONSTRAINT "orders_sku_fkey" FOREIGN KEY ("status") REFERENCES "inventory"."products" ("sku") ON DELETE RESTRICT ON UPDATE CASCADE',
    ]);
  });

  it('keeps indexes it cannot rebuild unless they are changed', () => {
    expect(isSimpleIndex(orders, orders.indexes[1]!)).toBe(true);
    expect(isSimpleIndex(orders, orders.indexes[2]!)).toBe(false);
    expect(validateDraft(orders, edit((d) => (d.indexes[2]!.name = 'renamed')))).toEqual({
      'indexes.2.columns': 'This index cannot be rebuilt here (expressions, a condition or options); drop it and create the new one in a script.',
    });
    expect(buildAlterTable(orders, edit((d) => (d.indexes[2]!.dropped = true)))).toEqual(['DROP INDEX "public"."orders_lower_idx"']);
  });

  it('checks identity columns and prefix lengths', () => {
    expect(
      validateDraft(
        orders,
        edit((d) => {
          d.columns[4]!.autoIncrement = true;
          d.columns[2]!.autoIncrement = true;
          d.columns[2]!.defaultSql = '0';
          d.indexes.push({ original: null, kind: 'INDEX', name: 'x', columns: 'status(3)', dropped: false });
        }),
      ),
    ).toEqual({
      'columns.2.defaultSql': 'Identity column “total” cannot have a default.',
      'columns.4.nullable': 'Identity column “customer_id” must be NOT NULL.',
      'indexes.3.columns': 'PostgreSQL indexes have no prefix lengths.',
    });
  });
});

describe('PostgreSQL schemas and databases', () => {
  it('lists public first and system schemas last, without TOAST and temporary ones', () => {
    expect(orderSchemas(['pg_toast', 'inventory', 'information_schema', 'public', 'pg_temp_3', 'pg_catalog', 'audit', 'pg_toast_temp_3'])).toEqual([
      'public',
      'audit',
      'inventory',
      'information_schema',
      'pg_catalog',
    ]);
  });

  it('lists the connected database first', () => {
    expect(orderDatabases(['analytics', 'postgres', 'shop'], 'shop')).toEqual(['shop', 'analytics', 'postgres']);
  });
});

describe('PostgreSQL data sources', () => {
  const base = () => createDataSourceSettings('postgres');

  it('starts with port 5432, user postgres and database postgres', () => {
    expect(base()).toMatchObject({ port: '5432', user: 'postgres', database: 'postgres', auth: 'password' });
    expect(base().properties).toEqual([
      { key: 'connectionTimeoutMillis', value: '10000' },
      { key: 'application_name', value: 'Datakit' },
    ]);
  });

  it('requires a user even without a password, and knows pg options', () => {
    const s: DataSourceSettings = { ...base(), name: 'pg', auth: 'none', user: ' ' };
    s.properties = [
      { key: 'statement_timeout', value: '5' },
      { key: 'keepAlive', value: 'yes' },
      { key: 'charset', value: 'utf8' },
    ];
    expect(validateDataSource(s, [])).toEqual({
      user: 'User is required.',
      'properties.0.key': '“statement_timeout” is set on the Options tab.',
      'properties.1.value': '“keepAlive” must be true or false.',
      'properties.2.key': '“charset” is not a pg option.',
    });
  });

  it('builds a postgresql:// URL with TLS settings and options, never the password', () => {
    const s = { ...base(), host: 'db.example.com', user: 'app', database: 'shop' };
    s.ssl = { enabled: true, mode: 'verify-full', caFile: '/certs/ca.pem', certFile: '', keyFile: '' };
    s.properties = [{ key: 'options', value: '-c search_path=inventory' }];
    expect(buildConnectionUrl(s)).toBe(
      'postgresql://app@db.example.com:5432/shop?sslmode=verify-full&sslrootcert=%2Fcerts%2Fca.pem&options=-c%20search_path%3Dinventory',
    );
  });

  it('reads postgres:// and postgresql:// URLs', () => {
    const parsed = parseConnectionUrl(
      'postgres://app:s3cr%40t@db.example.com:6543/shop?sslmode=verify-ca&sslrootcert=/certs/ca.pem&application_name=report&connect_timeout=5&target_session_attrs=any',
      base(),
    );
    expect(parsed).toEqual({
      ok: true,
      password: 's3cr@t',
      ignored: ['target_session_attrs'],
      settings: expect.objectContaining({
        host: 'db.example.com',
        port: '6543',
        user: 'app',
        database: 'shop',
        auth: 'password',
        ssl: { enabled: true, mode: 'verify-ca', caFile: '/certs/ca.pem', certFile: '', keyFile: '' },
        properties: [
          { key: 'application_name', value: 'report' },
          { key: 'connectionTimeoutMillis', value: '5000' },
        ],
      }),
    });
    const plain = parseConnectionUrl('postgresql://localhost/analytics?sslmode=prefer', base());
    expect(plain).toMatchObject({ ok: true, settings: { host: 'localhost', port: '5432', database: 'analytics', ssl: { enabled: false } } });
  });

  it('rejects other schemes, several hosts and sockets', () => {
    expect(parseConnectionUrl('mysql://localhost/shop', base())).toEqual({ ok: false, error: 'Unsupported URL scheme “mysql://”. Use postgres:// or postgresql://.' });
    expect(parseConnectionUrl('postgresql://a:5432,b:5432/shop', base())).toEqual({ ok: false, error: 'Only one host is supported.' });
    expect(parseConnectionUrl('postgresql:///shop?host=/var/run/postgresql', base())).toMatchObject({ ok: false });
    expect(parseConnectionUrl('postgresql://localhost/shop?sslmode=sometimes', base())).toMatchObject({ ok: false, error: expect.stringMatching(/^Unknown sslmode/) });
  });
});
