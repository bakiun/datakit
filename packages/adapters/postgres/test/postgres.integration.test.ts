import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAlterTable,
  buildChanges,
  buildCount,
  buildSelect,
  createDataSourceSettings,
  draftOf,
  parseConnectionUrl,
  validateDraft,
  type DataSourceSettings,
  type ServerNotice,
  type TableStructure,
} from '@datakit/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgresSession, testPostgresConnection } from '../src';

const APP_PASSWORD = 'app-secret';
const SSH_PASSWORD = 'tunnel-secret';
/** The sample databases of the dev server: `shop` and `analytics`, owned by `app`. */
const INIT_SQL = fileURLToPath(new URL('../../../../docker/postgres/init.sql', import.meta.url));

let network: StartedNetwork;
let server: StartedPostgreSqlContainer;
let sshd: StartedTestContainer;
let caFile: string;

function appSettings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('postgres');
  s.name = 'shop';
  s.host = server.getHost();
  s.port = String(server.getPort());
  s.user = 'app';
  s.database = 'shop';
  patch(s);
  return s;
}

/** A superuser connection, for what the app user may not do. */
async function asSuperuser<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ host: server.getHost(), port: server.getPort(), user: 'test', password: 'test', database: 'shop' });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  // A self-signed certificate whose name is not the host's: Verify CA accepts it, Full verification does not.
  const folder = await mkdtemp(join(tmpdir(), 'datakit-pg-tls-'));
  caFile = join(folder, 'server.crt');
  const keyFile = join(folder, 'server.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=datakit-test', '-keyout', keyFile, '-out', caFile], {
    stdio: 'ignore',
  });

  network = await new Network().start();
  [server, sshd] = await Promise.all([
    new PostgreSqlContainer('postgres:17')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .withSSL(caFile, keyFile)
      .withCopyFilesToContainer([{ source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql' }])
      .start(),
    // The same image Testcontainers uses for port forwarding; TCP forwarding is allowed.
    new GenericContainer('testcontainers/sshd:1.2.0')
      .withNetwork(network)
      .withExposedPorts(22)
      .withEnvironment({ USERNAME: 'root', PASSWORD: SSH_PASSWORD })
      .start(),
  ]);
});

afterAll(async () => {
  await Promise.all([server?.stop(), sshd?.stop()]);
  await network?.stop();
});

describe('testPostgresConnection', () => {
  it('reports the server version and latency', async () => {
    const result = await testPostgresConnection(appSettings(), { password: APP_PASSWORD });
    expect(result.serverVersion).toEqual({ product: 'PostgreSQL', version: expect.stringMatching(/^17\.\d+$/) });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes on the server error for a wrong password or database', async () => {
    await expect(testPostgresConnection(appSettings(), { password: 'wrong' })).rejects.toThrow('password authentication failed for user "app"');
    await expect(testPostgresConnection(appSettings((s) => (s.database = 'nope')), { password: APP_PASSWORD })).rejects.toThrow('database "nope" does not exist');
  });

  it('asks for a password the data source does not send', async () => {
    await expect(testPostgresConnection(appSettings((s) => (s.auth = 'none')), {})).rejects.toThrow(
      'The server asks for a password; set Authentication to User & Password.',
    );
  });

  it('explains a refused connection', async () => {
    const settings = appSettings((s) => {
      s.host = '127.0.0.1';
      s.port = '1';
    });
    await expect(testPostgresConnection(settings, {})).rejects.toThrow('Connection refused (127.0.0.1:1).');
  });

  it('runs “Run on connect” after making the session read-only', async () => {
    const settings = appSettings((s) => {
      s.options.initSql = "SET TIME ZONE 'Europe/Istanbul';\nSELECT set_config('datakit.greeting', 'hi', false);";
    });
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD })).resolves.toBeDefined();

    settings.options.readOnly = true;
    settings.options.initSql = "INSERT INTO customers (name, email) VALUES ('Grace', 'g@example.com')";
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD })).rejects.toThrow(/“Run on connect” failed: .*read-only transaction/);
  });
});

describe('driver properties and URLs', () => {
  it('applies driver properties such as connectionTimeoutMillis', async () => {
    // A server that accepts the TCP connection but never answers the startup message.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const settings = appSettings((s) => {
        s.host = '127.0.0.1';
        s.port = String(port);
        s.properties = [{ key: 'connectionTimeoutMillis', value: '300' }];
      });
      const started = Date.now();
      await expect(testPostgresConnection(settings, {})).rejects.toThrow(`Connection timed out (127.0.0.1:${port}).`);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      silent.close();
    }
  });

  it('connects with the settings and password read from a URL', async () => {
    const url =
      `postgresql://app:${encodeURIComponent(APP_PASSWORD)}@${server.getHost()}:${server.getPort()}/shop` +
      `?sslmode=verify-ca&sslrootcert=${encodeURIComponent(caFile)}&application_name=report&options=-c%20search_path%3Dinventory`;
    const parsed = parseConnectionUrl(url, createDataSourceSettings('postgres'));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.settings.ssl).toMatchObject({ enabled: true, mode: 'verify-ca', caFile });
    const session = await openPostgresSession(parsed.settings, { password: parsed.password });
    try {
      const result = await session.execute("SELECT current_setting('application_name'), current_schema(), ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      expect(result.kind === 'rows' && result.rows[0]).toEqual(['report', 'inventory', true]);
    } finally {
      await session.close();
    }
  });
});

describe('TLS', () => {
  it('connects with Require and Verify CA', async () => {
    for (const mode of ['require', 'verify-ca'] as const) {
      const settings = appSettings((s) => {
        s.ssl = { enabled: true, mode, caFile, certFile: '', keyFile: '' };
      });
      await expect(testPostgresConnection(settings, { password: APP_PASSWORD })).resolves.toBeDefined();
    }
  });

  it('rejects a certificate for another host under Full verification', async () => {
    const settings = appSettings((s) => {
      s.ssl = { enabled: true, mode: 'verify-full', caFile, certFile: '', keyFile: '' };
    });
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD })).rejects.toThrow(/Hostname\/IP does not match|altnames/);
  });

  it('names a missing CA file', async () => {
    const settings = appSettings((s) => {
      s.ssl = { enabled: true, mode: 'verify-ca', caFile: '/missing/ca.pem', certFile: '', keyFile: '' };
    });
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD })).rejects.toThrow('Could not read CA file “/missing/ca.pem”');
  });
});

describe('SSH tunnel', () => {
  it('reaches the server through the SSH host, with TLS checked against the real host', async () => {
    const settings = appSettings((s) => {
      s.host = 'postgres';
      s.port = '5432';
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
      s.ssl = { enabled: true, mode: 'verify-ca', caFile, certFile: '', keyFile: '' };
    });
    const result = await testPostgresConnection(settings, { password: APP_PASSWORD, sshPassword: SSH_PASSWORD });
    expect(result.serverVersion.product).toBe('PostgreSQL');
    settings.ssl.mode = 'verify-full';
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD, sshPassword: SSH_PASSWORD })).rejects.toThrow(/Hostname\/IP does not match|altnames/);
  });

  it('reports a failed SSH login', async () => {
    const settings = appSettings((s) => {
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
    });
    await expect(testPostgresConnection(settings, { password: APP_PASSWORD, sshPassword: 'wrong' })).rejects.toThrow(/^SSH connection to .* failed/);
  });
});

type Session = Awaited<ReturnType<typeof openPostgresSession>>;

async function rowsOf(session: Session, sql: string) {
  const result = await session.execute(sql);
  if (result.kind !== 'rows') throw new Error(`Expected rows from ${sql}`);
  return result;
}

describe('browsing', () => {
  let session: Session;
  beforeAll(async () => {
    session = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
  });
  afterAll(() => session?.close());

  it('lists databases, and schemas with public first and the system ones last', async () => {
    expect(session.database).toBe('shop');
    expect(await session.listDatabases()).toEqual(expect.arrayContaining(['analytics', 'postgres', 'shop']));
    expect(await session.listDatabases()).not.toContain('template0');
    expect(await session.listSchemas()).toEqual(['public', 'inventory', 'information_schema', 'pg_catalog']);
  });

  it('lists the objects of a schema by kind', async () => {
    const objects = await session.listSchemaObjects('public');
    expect(objects.tables.map((t) => t.name)).toEqual(['customers', 'orders']);
    expect(objects.views).toEqual(['order_totals']);
    expect(objects.materializedViews.map((m) => m.name)).toEqual(['customer_stats']);
    expect(objects.sequences).toEqual(['customers_id_seq', 'invoice_number_seq', 'orders_id_seq']);
    expect(objects.functions).toEqual([{ name: 'customer_total', args: 'cid integer' }]);
    // Procedures name the mode of their arguments.
    expect(objects.procedures).toEqual([{ name: 'mark_shipped', args: 'IN order_id bigint' }]);
    expect(objects.types).toEqual([
      { name: 'email_address', kind: 'domain' },
      { name: 'order_status', kind: 'enum' },
    ]);
    expect((await session.listSchemaObjects('inventory')).tables.map((t) => t.name)).toEqual(['products', 'stock_movements']);
    expect(await session.listObjects('public')).toMatchObject({ views: ['customer_stats', 'order_totals'], functions: ['customer_total'], procedures: ['mark_shipped'] });
  });

  it('finds objects of every schema by name', async () => {
    const found = await session.searchObjects('ORDER', 100);
    expect(found.filter((m) => m.schema === 'public').map((m) => [m.kind, m.name])).toEqual([
      ['view', 'order_totals'],
      ['table', 'orders'],
    ]);
    expect((await session.searchObjects('_', 100)).filter((m) => m.schema !== 'pg_catalog' && m.schema !== 'information_schema').map((m) => [m.kind, m.name])).toEqual([
      ['table', 'stock_movements'],
      ['materializedView', 'customer_stats'],
      ['function', 'customer_total'],
      ['procedure', 'mark_shipped'],
      ['view', 'order_totals'],
    ]);
    expect(await session.searchObjects('e', 2)).toHaveLength(2);
  });

  it('opens a session in another database', async () => {
    const analytics = await openPostgresSession(appSettings((s) => (s.database = 'analytics')), { password: APP_PASSWORD });
    try {
      expect(analytics.database).toBe('analytics');
      expect((await analytics.listSchemaObjects('public')).tables.map((t) => t.name)).toEqual(['events']);
    } finally {
      await analytics.close();
    }
  });

  it('puts a schema first in the search path', async () => {
    expect(await session.currentSchema()).toBe('public');
    await session.setSchema('inventory');
    expect(await session.currentSchema()).toBe('inventory');
    expect((await rowsOf(session, 'SELECT count(*) FROM products')).rows[0]).toEqual(['3']);
    await session.setSchema('public');
    expect(await session.currentSchema()).toBe('public');
  });

  it('reports a connection terminated on the server, and a normal close without an error', async () => {
    const doomed = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    const closed = new Promise<Error | undefined>((resolve) => doomed.onDidClose(resolve));
    await asSuperuser((client) => client.query('SELECT pg_terminate_backend($1)', [doomed.connectionId]));
    expect(await closed).toBeInstanceOf(Error);

    const other = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    const ended = new Promise<Error | undefined>((resolve) => other.onDidClose(resolve));
    await other.close();
    expect(await ended).toBeUndefined();
  });
});

describe('table data', () => {
  let session: Session;
  let customers: TableStructure;
  let products: TableStructure;
  const page = { where: '', sort: [{ column: 'id', direction: 'asc' as const }], limit: 50, offset: 0 };
  const names = async () => (await rowsOf(session, buildSelect(customers, page))).rows.map((r) => r[1]);

  beforeAll(async () => {
    session = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    customers = await session.describeTable('public', 'customers');
    products = await session.describeTable('inventory', 'products');
  });
  afterAll(() => session?.close());

  it('describes columns, keys, identity, enums and defaults', async () => {
    expect(customers).toMatchObject({ dialect: 'postgres', database: 'shop', schema: 'public', kind: 'table', rowKey: ['id'], options: null });
    const orders = await session.describeTable('public', 'orders');
    const byName = Object.fromEntries(orders.columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({ columnType: 'bigint', dataType: 'int8', key: 'PRI', autoIncrement: true, identity: 'by default', generated: false, numeric: true });
    expect(byName.public_id).toMatchObject({ columnType: 'uuid', key: 'UNI', defaultSql: 'gen_random_uuid()' });
    expect(byName.status).toMatchObject({ enumValues: ['pending', 'paid', 'shipped', 'cancelled'], defaultSql: "'pending'::order_status", key: 'MUL' });
    expect(byName.total).toMatchObject({ columnType: 'numeric(12,2)', numeric: true, nullable: false });
    expect(byName.details).toMatchObject({ dataType: 'jsonb', nullable: true, defaultSql: null });
    expect(byName.delivery_window?.dataType).toBe('interval');
    const customerColumns = Object.fromEntries(customers.columns.map((c) => [c.name, c]));
    expect(customerColumns.id).toMatchObject({ identity: 'always', generated: true, autoIncrement: true, extra: 'GENERATED ALWAYS AS IDENTITY' });
    expect(customerColumns.tags).toMatchObject({ columnType: 'text[]', dataType: 'text[]', comment: 'Free-form labels', enumValues: null });
    expect(customerColumns.email?.columnType).toBe('email_address');
    expect(Object.fromEntries(products.columns.map((c) => [c.name, c])).in_stock?.enumValues).toEqual(['true', 'false']);
    expect(orders.indexes.map((i) => [i.name, i.kind, i.columns, i.constraint])).toEqual([
      ['orders_pkey', 'PRIMARY', ['id'], true],
      ['orders_public_id_key', 'UNIQUE', ['public_id'], true],
      ['orders_status_idx', 'INDEX', ['status', 'placed_at'], false],
    ]);
    expect(orders.foreignKeys).toEqual([
      {
        name: 'orders_customer_id_fkey',
        columns: ['customer_id'],
        refDatabase: 'shop',
        refSchema: 'public',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      },
    ]);
    expect(orders.checks).toEqual([{ name: 'orders_total_check', clause: 'total >= 0::numeric' }]);
    expect(buildAlterTable(orders, draftOf(orders))).toEqual([]);
  });

  it('describes views, materialized views and tables without a key, and rejects unknown tables', async () => {
    expect(await session.describeTable('public', 'order_totals')).toMatchObject({ kind: 'view', rowKey: [] });
    expect(await session.describeTable('public', 'customer_stats')).toMatchObject({ kind: 'materializedView' });
    expect(await session.describeTable('inventory', 'stock_movements')).toMatchObject({ kind: 'table', rowKey: [] });
    await expect(session.describeTable('public', 'nope')).rejects.toThrow('Table “public.nope” does not exist.');
  });

  it('shows values as the server writes them, without losing precision', async () => {
    const result = await rowsOf(session, buildSelect(products, { where: '', sort: [{ column: 'sku', direction: 'asc' }], limit: 10, offset: 0 }));
    expect(result.fields.map((f) => f.name)).toEqual(['sku', 'name', 'unit', 'price', 'stock', 'in_stock', 'photo', 'supplier_ip', 'attributes']);
    expect(result.fields.map((f) => f.type)).toEqual(['text', 'text', 'unit', 'numeric', 'int8', 'bool', 'bytea', 'inet', 'jsonb']);
    expect(result.fields.map((f) => [f.numeric, f.binary])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [true, false],
      [true, false],
      [false, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
    const book = result.rows.find((r) => r[0] === 'BOOK-1')!;
    expect(book.slice(0, 6)).toEqual(['BOOK-1', 'Notes on the Analytical Engine', 'piece', '19.90', '9007199254740993', true]);
    expect(book[6]).toEqual(Buffer.from([0xca, 0xfe]));
    expect(book.slice(7)).toEqual(['192.168.1.10', '{"pages": 66}']);

    const orders = await rowsOf(session, 'SELECT public_id, placed_at, delivery_window, details FROM orders ORDER BY id LIMIT 1');
    expect(orders.fields.map((f) => f.type)).toEqual(['uuid', 'timestamptz', 'interval', 'jsonb']);
    expect(orders.rows[0]?.[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(orders.rows[0]?.slice(1)).toEqual(['2026-10-24 09:14:02.123456+00', '2 days', '{"gift": true, "items": 2}']);
    expect((await rowsOf(session, "SELECT tags FROM customers WHERE email = 'ada@example.com'")).rows[0]).toEqual(['{math,poetry}']);
    const count = await rowsOf(session, buildCount(customers, "name LIKE 'A%'"));
    expect(count.rows[0]).toEqual(['1']);
  });

  it('reports which table column each result column comes from', async () => {
    const result = await rowsOf(session, 'SELECT o.id, o.total AS amount, 1 AS one, p.sku FROM orders o, inventory.products p LIMIT 1');
    expect(result.fields.map((f) => [f.name, f.source])).toEqual([
      ['id', { database: 'shop', schema: 'public', table: 'orders', column: 'id' }],
      ['amount', { database: 'shop', schema: 'public', table: 'orders', column: 'total' }],
      ['one', null],
      ['sku', { database: 'shop', schema: 'inventory', table: 'products', column: 'sku' }],
    ]);
  });

  it('writes grid changes with typed parameters in one transaction', async () => {
    const loaded = (await rowsOf(session, buildSelect(customers, page))).rows;
    const statements = buildChanges(
      customers,
      [
        { kind: 'update', row: 2, values: { name: "Grace B. Hopper's", tags: '{navy,cobol}' } },
        { kind: 'insert', values: { name: 'Edsger', email: 'edsger@example.com', tags: '{}' } },
      ],
      (row) => [loaded[row]?.[0]],
    );
    expect(await session.write(statements, true)).toEqual([1, 1]);
    expect(await names()).toEqual(['Ada Lovelace', 'Linus Torvalds', "Grace B. Hopper's", 'Edsger']);
    expect((await rowsOf(session, "SELECT tags FROM customers WHERE email = 'grace@example.com'")).rows[0]).toEqual(['{navy,cobol}']);
    expect(session.format(statements[0]!)).toBe(`UPDATE "public"."customers" SET "name" = 'Grace B. Hopper''s', "tags" = '{navy,cobol}' WHERE "id" = 3`);

    const sku = buildChanges(
      products,
      [
        { kind: 'insert', values: { sku: 'PEN-1', name: 'Pen', unit: 'piece', price: '2.5', stock: '9007199254740995', in_stock: 'true', supplier_ip: '::1', attributes: '{"ink": "blue"}' } },
        { kind: 'update', row: 0, values: { unit: 'kg', in_stock: 'false' } },
      ],
      () => ['TEA-1'],
    );
    await session.write(sku, true);
    const pen = await rowsOf(session, "SELECT price, stock, in_stock, supplier_ip, attributes FROM inventory.products WHERE sku = 'PEN-1'");
    expect(pen.rows[0]).toEqual(['2.50', '9007199254740995', true, '::1', '{"ink": "blue"}']);
    expect((await rowsOf(session, "SELECT unit, in_stock FROM inventory.products WHERE sku = 'TEA-1'")).rows[0]).toEqual(['kg', false]);
    await expect(session.write(buildChanges(products, [{ kind: 'update', row: 0, values: { unit: 'gallon' } }], () => ['TEA-1']), true)).rejects.toThrow(
      'invalid input value for enum inventory.unit: "gallon"',
    );
  });

  it('undoes the whole write when a row no longer matches', async () => {
    const statements = buildChanges(
      customers,
      [
        { kind: 'insert', values: { name: 'Barbara', email: 'barbara@example.com' } },
        { kind: 'delete', row: 0 },
      ],
      () => [999],
    );
    await expect(session.write(statements, true)).rejects.toThrow(/changed or deleted by someone else/);
    expect(await names()).not.toContain('Barbara');
    expect(session.inTransaction).toBe(false);
  });

  it('keeps a manual transaction open until commit or rollback', async () => {
    const other = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    try {
      const insert = (name: string) => buildChanges(customers, [{ kind: 'insert', values: { name, email: `${name}@example.com` } }], () => []);
      await session.write(insert('pending'), false);
      expect(session.inTransaction).toBe(true);
      expect(await names()).toContain('pending');
      expect((await rowsOf(other, buildSelect(customers, page))).rows.map((r) => r[1])).not.toContain('pending');
      await session.rollback();
      expect(await names()).not.toContain('pending');

      await session.write(insert('kept'), false);
      await expect(session.write(insert('kept'), false)).rejects.toThrow(/duplicate key value violates unique constraint "customers_email_key"/);
      expect(session.inTransaction).toBe(true);
      await session.commit();
      expect((await rowsOf(other, buildSelect(customers, page))).rows.map((r) => r[1])).toContain('kept');
    } finally {
      await other.close();
    }
  });

  it('follows transactions opened by the script, including failed ones', async () => {
    await session.execute('BEGIN');
    expect(session.inTransaction).toBe(true);
    await expect(session.execute('SELECT nope')).rejects.toThrow('column "nope" does not exist');
    expect(session.inTransaction).toBe(true);
    await session.execute('ROLLBACK');
    expect(session.inTransaction).toBe(false);
    expect(await session.execute("UPDATE customers SET name = name WHERE email LIKE '%@example.com'")).toMatchObject({ kind: 'ok', affectedRows: 5 });
    const inserted = await rowsOf(session, "INSERT INTO customers (name, email) VALUES ('Returning', 'returning@example.com') RETURNING id, name");
    expect(inserted.rows[0]?.[1]).toBe('Returning');
    await session.execute("DELETE FROM customers WHERE email = 'returning@example.com'");
  });

  it('streams rows one at a time', async () => {
    const seen: unknown[][] = [];
    let fieldNames: string[] = [];
    const count = await session.streamRows(
      'SELECT id, name FROM customers ORDER BY id',
      (fields) => void (fieldNames = fields.map((f) => f.name)),
      async (row) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(row);
      },
    );
    expect(fieldNames).toEqual(['id', 'name']);
    expect(count).toBe(seen.length);
    expect(seen[0]).toEqual([1, 'Ada Lovelace']);
    expect(await session.streamRows('SELECT id FROM customers WHERE false', (f) => void (fieldNames = f.map((x) => x.name)), () => {})).toBe(0);
    expect(fieldNames).toEqual(['id']);
    expect((await rowsOf(session, 'SHOW statement_timeout')).rows[0]).toEqual(['1min']);
  });

  it('stops a running query from another session', async () => {
    const other = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    try {
      const started = Date.now();
      const running = other.execute('SELECT pg_sleep(20)').catch((error: Error) => error);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await session.stopQuery(other.connectionId);
      expect(await running).toMatchObject({ message: 'canceling statement due to user request' });
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await other.close();
    }
  });

  it('passes on notices and warnings the server sends', async () => {
    const notices: ServerNotice[] = [];
    session.onNotice((notice) => notices.push(notice));
    await session.execute('CALL mark_shipped(2)');
    await session.execute("DO $$ BEGIN RAISE WARNING 'Stock is low'; END $$");
    expect(notices).toEqual([
      { severity: 'NOTICE', message: 'Order 2 shipped' },
      { severity: 'WARNING', message: 'Stock is low' },
    ]);
  });

  it('explains statements, and rolls back what EXPLAIN ANALYZE ran', async () => {
    const plan = await session.explain('SELECT * FROM orders WHERE id = 1', false);
    expect(plan.kind === 'rows' && plan.fields.map((f) => f.name)).toEqual(['QUERY PLAN']);
    expect(plan.kind === 'rows' && String(plan.rows[0]?.[0])).toMatch(/Scan/);
    const analyzed = await session.explain("DELETE FROM customers WHERE email = 'kept@example.com'", true);
    expect(analyzed.kind === 'rows' && analyzed.rows.map((r) => String(r[0])).join('\n')).toMatch(/actual time=.*\n[\s\S]*Execution Time/);
    expect(await names()).toContain('kept');
    expect(session.inTransaction).toBe(false);
  });

  it('shows the DDL of tables, views, routines, sequences and types', async () => {
    const table = await session.showCreate('public', 'customers', 'table');
    expect(table).toContain('CREATE TABLE public.customers (\n    id integer GENERATED ALWAYS AS IDENTITY NOT NULL,');
    expect(table).toContain("    tags text[] DEFAULT '{}'::text[] NOT NULL,");
    expect(table).toContain('    CONSTRAINT customers_pkey PRIMARY KEY (id),\n    CONSTRAINT customers_email_key UNIQUE (email)\n)');
    expect(table).toContain("COMMENT ON TABLE public.customers IS 'People who order'");
    expect(await session.showCreate('public', 'orders', 'table')).toContain('CREATE INDEX orders_status_idx ON public.orders USING btree (status, placed_at)');
    expect(await session.showCreate('public', 'order_totals', 'view')).toMatch(/^CREATE OR REPLACE VIEW public\.order_totals AS\nSELECT customer_id,/);
    expect(await session.showCreate('public', 'customer_stats', 'materializedView')).toMatch(
      /^CREATE MATERIALIZED VIEW public\.customer_stats AS\n[\s\S]*\nWITH DATA;\n\nCREATE UNIQUE INDEX customer_stats_id_idx/,
    );
    expect(await session.definition('public', 'customer_total', 'function', 'cid integer')).toMatch(/^CREATE OR REPLACE FUNCTION public\.customer_total\(cid integer\)/);
    expect(await session.definition('public', 'mark_shipped', 'procedure')).toMatch(/^CREATE OR REPLACE PROCEDURE public\.mark_shipped\((IN )?order_id bigint\)/);
    expect(await session.definition('public', 'invoice_number_seq', 'sequence')).toBe(
      'CREATE SEQUENCE public.invoice_number_seq\n    AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1000 CACHE 1 NO CYCLE',
    );
    expect(await session.definition('public', 'orders_id_seq', 'sequence')).toContain('OWNED BY public.orders.id');
    expect(await session.definition('public', 'order_status', 'type')).toBe("CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled')");
    expect(await session.definition('public', 'email_address', 'type')).toBe(
      "CREATE DOMAIN public.email_address AS text\n    CONSTRAINT email_address_check CHECK (VALUE ~~ '%_@_%'::text)",
    );
    await expect(session.definition('public', 'nope', 'function')).rejects.toThrow('Routine “public.nope” does not exist.');
  });

  it('runs the DDL it shows', async () => {
    // The table's DDL recreates it in another schema.
    const ddl = await session.showCreate('inventory', 'products', 'table');
    await session.execute('CREATE SCHEMA ddl_copy');
    try {
      const statements = ddl.split(';\n\n').map((s) => s.replace(/inventory\.products/g, 'ddl_copy.products').replace(/ON inventory\./g, 'ON ddl_copy.'));
      await session.write(statements.map((sql) => ({ sql, params: [] })), true);
      const copy = await session.describeTable('ddl_copy', 'products');
      expect(copy.columns.map((c) => [c.name, c.columnType, c.nullable, c.defaultSql])).toEqual(products.columns.map((c) => [c.name, c.columnType, c.nullable, c.defaultSql]));
    } finally {
      await session.execute('DROP SCHEMA ddl_copy CASCADE');
    }
  });
});

describe('structure changes', () => {
  let session: Session;
  const describeProbe = () => session.describeTable('public', 'probe');

  beforeAll(async () => {
    session = await openPostgresSession(appSettings(), { password: APP_PASSWORD });
    await session.execute(`CREATE TABLE probe (
      id integer NOT NULL,
      code char(3) NOT NULL DEFAULT 'TRY',
      n numeric(5,2) DEFAULT 0 CONSTRAINT probe_n_check CHECK (n >= 0),
      g numeric(6,2) GENERATED ALWAYS AS (n * 2) STORED,
      customer_id integer,
      note varchar(20),
      CONSTRAINT probe_pkey PRIMARY KEY (id),
      CONSTRAINT probe_customer_fkey FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE SET NULL
    )`);
    await session.execute('CREATE INDEX probe_lower_note_idx ON probe (lower(note))');
    await session.execute("COMMENT ON COLUMN probe.code IS 'it''s code'");
  });
  afterAll(async () => {
    await session?.execute('DROP TABLE IF EXISTS probe');
    await session?.close();
  });

  it('reads the table back into an unchanged draft', async () => {
    const probe = await describeProbe();
    const byName = Object.fromEntries(probe.columns.map((c) => [c.name, c]));
    expect(byName.code).toMatchObject({ defaultSql: "'TRY'::bpchar", comment: "it's code", columnType: 'character(3)' });
    expect(byName.g).toMatchObject({ generated: true, generation: { expression: '(n * (2)::numeric)', stored: true }, defaultSql: null });
    expect(probe.indexes.find((i) => i.name === 'probe_lower_note_idx')?.columns).toEqual(['lower(note::text)']);
    expect(buildAlterTable(probe, draftOf(probe))).toEqual([]);
    expect(validateDraft(probe, draftOf(probe))).toEqual({});
  });

  it('applies column, index and constraint changes in one transaction', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    const column = (name: string) => draft.columns.find((c) => c.original === name)!;
    column('note').name = 'remark';
    column('note').type = 'varchar(40)';
    column('code').comment = 'ISO currency';
    column('code').defaultSql = "'EUR'";
    column('id').autoIncrement = true;
    column('customer_id').nullable = false;
    draft.columns.push({ original: null, name: 'flag', type: 'boolean', nullable: false, defaultSql: 'false', autoIncrement: false, comment: 'New', dropped: false });
    draft.indexes.push({ original: null, kind: 'UNIQUE', name: 'probe_code_key', columns: 'code, remark', dropped: false });
    draft.indexes.push({ original: null, kind: 'INDEX', name: 'probe_flag_idx', columns: 'flag DESC', dropped: false });
    draft.foreignKeys[0]!.onDelete = 'CASCADE';
    draft.checks.push({ original: null, name: 'probe_flag_check', clause: 'flag OR n > 0', dropped: false });
    expect(validateDraft(before, draft)).toEqual({});

    const statements = buildAlterTable(before, draft);
    await session.write(statements.map((sql) => ({ sql, params: [] })), true);

    const after = await describeProbe();
    const byName = Object.fromEntries(after.columns.map((c) => [c.name, c]));
    expect(after.columns.map((c) => c.name)).toEqual(['id', 'code', 'n', 'g', 'customer_id', 'remark', 'flag']);
    expect(byName.id).toMatchObject({ identity: 'by default', nullable: false });
    expect(byName.code).toMatchObject({ comment: 'ISO currency', defaultSql: "'EUR'::bpchar" });
    expect(byName.customer_id?.nullable).toBe(false);
    expect(byName.remark).toMatchObject({ columnType: 'character varying(40)' });
    expect(byName.flag).toMatchObject({ nullable: false, defaultSql: 'false', comment: 'New' });
    expect(after.indexes.map((i) => [i.name, i.kind, i.columns])).toEqual([
      ['probe_pkey', 'PRIMARY', ['id']],
      ['probe_code_key', 'UNIQUE', ['code', 'remark']],
      ['probe_flag_idx', 'INDEX', ['flag']],
      ['probe_lower_note_idx', 'INDEX', ['lower(remark::text)']],
    ]);
    expect(after.foreignKeys[0]).toMatchObject({ name: 'probe_customer_fkey', onDelete: 'CASCADE', columns: ['customer_id'] });
    expect(after.checks.map((c) => c.name)).toEqual(['probe_flag_check', 'probe_n_check']);
    expect(buildAlterTable(after, draftOf(after))).toEqual([]);
  });

  it('applies nothing when one statement of the change set fails', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    draft.columns.find((c) => c.original === 'flag')!.dropped = true;
    draft.columns.find((c) => c.original === 'remark')!.type = 'no_such_type';
    await expect(session.write(buildAlterTable(before, draft).map((sql) => ({ sql, params: [] })), true)).rejects.toThrow('type "no_such_type" does not exist');
    const after = await describeProbe();
    expect(after.columns.map((c) => c.name)).toContain('flag');
    expect(session.inTransaction).toBe(false);
  });

  it('drops columns, indexes and the primary key, and drops identity', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    draft.columns.find((c) => c.original === 'flag')!.dropped = true;
    draft.columns.find((c) => c.original === 'id')!.autoIncrement = false;
    draft.indexes.find((i) => i.name === 'probe_lower_note_idx')!.dropped = true;
    draft.indexes.find((i) => i.kind === 'PRIMARY')!.columns = 'id, code';
    draft.checks.find((c) => c.name === 'probe_flag_check')!.dropped = true;
    await session.write(buildAlterTable(before, draft).map((sql) => ({ sql, params: [] })), true);
    const after = await describeProbe();
    expect(after.columns.map((c) => c.name)).not.toContain('flag');
    expect(after.columns.find((c) => c.name === 'id')?.identity).toBeNull();
    expect(after.indexes.map((i) => i.name)).toEqual(['probe_pkey', 'probe_code_key']);
    expect(after.rowKey).toEqual(['id', 'code']);
  });
});
