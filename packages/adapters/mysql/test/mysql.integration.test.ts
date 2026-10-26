import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAlterTable,
  buildChanges,
  buildCount,
  buildSelect,
  createDataSourceSettings,
  draftOf,
  parseConnectionUrl,
  type DataSourceSettings,
  type TableStructure,
} from '@datakit/core';
import { MariaDbContainer, type StartedMariaDbContainer } from '@testcontainers/mariadb';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import mysql from 'mysql2/promise';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMysqlSession, testMysqlConnection } from '../src';

const APP_PASSWORD = 'app-secret';
const SSH_PASSWORD = 'tunnel-secret';

let network: StartedNetwork;
let server: StartedMySqlContainer;
let mariadb: StartedMariaDbContainer;
let sshd: StartedTestContainer;
let caFile: string;

const SCHEMA = [
  "CREATE USER 'app'@'%' IDENTIFIED BY 'app-secret'",
  "GRANT ALL ON shop.* TO 'app'@'%'",
  'CREATE TABLE shop.customers (id INT PRIMARY KEY, name VARCHAR(50))',
  'CREATE TABLE shop.orders (id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2))',
  "INSERT INTO shop.customers VALUES (1, 'Ada'), (2, 'Linus')",
  'CREATE VIEW shop.order_totals AS SELECT customer_id, SUM(total) AS total FROM shop.orders GROUP BY customer_id',
  'CREATE PROCEDURE shop.refresh_stats() BEGIN ANALYZE TABLE shop.orders; END',
  'CREATE FUNCTION shop.order_count() RETURNS INT DETERMINISTIC READS SQL DATA RETURN (SELECT COUNT(*) FROM shop.orders)',
  `CREATE TABLE shop.samples (
     id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     label VARCHAR(20) NOT NULL DEFAULT 'none',
     status ENUM('new', 'it''s done') NULL,
     payload JSON NULL,
     photo BLOB NULL,
     amount DECIMAL(12, 2) NULL,
     created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     doubled DECIMAL(13, 2) AS (amount * 2) VIRTUAL,
     UNIQUE KEY uq_label (label)
   )`,
  `INSERT INTO shop.samples (label, status, payload, photo, amount, created)
     VALUES ('first', 'new', '{"a": 1}', X'CAFE', 12.50, '2026-10-24 09:14:02'), ('second', NULL, NULL, NULL, NULL, '2026-10-24 10:00:00')`,
];

async function seed(host: string, port: number, password: string): Promise<void> {
  const root = await mysql.createConnection({ host, port, user: 'root', password });
  for (const statement of SCHEMA) await root.query(statement);
  await root.end();
}

function appSettings(patch: (s: DataSourceSettings) => void = () => {}): DataSourceSettings {
  const s = createDataSourceSettings('mysql');
  s.name = 'shop';
  s.host = server.getHost();
  s.port = String(server.getPort());
  s.user = 'app';
  s.database = 'shop';
  patch(s);
  return s;
}

beforeAll(async () => {
  network = await new Network().start();
  [server, mariadb, sshd] = await Promise.all([
    new MySqlContainer('mysql:8.4')
      .withNetwork(network)
      .withNetworkAliases('mysql')
      .withDatabase('shop')
      .withRootPassword('root-secret')
      .start(),
    new MariaDbContainer('mariadb:11.4').withDatabase('shop').withRootPassword('root-secret').start(),
    // The same image Testcontainers uses for port forwarding; TCP forwarding is allowed.
    new GenericContainer('testcontainers/sshd:1.2.0')
      .withNetwork(network)
      .withExposedPorts(22)
      .withEnvironment({ USERNAME: 'root', PASSWORD: SSH_PASSWORD })
      .start(),
  ]);
  await seed(server.getHost(), server.getPort(), 'root-secret');
  await seed(mariadb.getHost(), mariadb.getPort(), 'root-secret');

  const ca = await server.exec(['cat', '/var/lib/mysql/ca.pem']);
  caFile = join(await mkdtemp(join(tmpdir(), 'datakit-tls-')), 'ca.pem');
  await writeFile(caFile, ca.output);
});

afterAll(async () => {
  await Promise.all([server?.stop(), mariadb?.stop(), sshd?.stop()]);
  await network?.stop();
});

describe('testMysqlConnection', () => {
  it('reports the server version and latency', async () => {
    const result = await testMysqlConnection(appSettings(), { password: APP_PASSWORD });
    expect(result.serverVersion.product).toBe('MySQL');
    expect(result.serverVersion.version).toMatch(/^8\.4\.\d+$/);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes on the server error for a wrong password', async () => {
    await expect(testMysqlConnection(appSettings(), { password: 'wrong' })).rejects.toThrow(/Access denied for user 'app'/);
  });

  it('explains a refused connection', async () => {
    const settings = appSettings((s) => {
      s.host = '127.0.0.1';
      s.port = '1';
    });
    await expect(testMysqlConnection(settings, {})).rejects.toThrow('Connection refused (127.0.0.1:1).');
  });

  it('runs “Run on connect” after making the session read-only', async () => {
    const settings = appSettings((s) => {
      s.options.initSql = "SET time_zone = '+03:00';\nSET @greeting = 'hi';";
    });
    await expect(testMysqlConnection(settings, { password: APP_PASSWORD })).resolves.toBeDefined();

    settings.options.readOnly = true;
    settings.options.initSql = "INSERT INTO customers VALUES (3, 'Grace')";
    await expect(testMysqlConnection(settings, { password: APP_PASSWORD })).rejects.toThrow(/“Run on connect” failed: .*READ ONLY/);
  });
});

describe('driver properties and URLs', () => {
  it('applies driver properties such as connectTimeout', async () => {
    // A server that accepts the TCP connection but never sends the MySQL handshake.
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const settings = appSettings((s) => {
        s.host = '127.0.0.1';
        s.port = String(port);
        s.properties = [{ key: 'connectTimeout', value: '300' }];
      });
      const started = Date.now();
      await expect(testMysqlConnection(settings, {})).rejects.toThrow(`Connection timed out (127.0.0.1:${port}).`);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      silent.close();
    }
  });

  it('connects with the settings and password read from a URL', async () => {
    const url =
      `mysql://app:${encodeURIComponent(APP_PASSWORD)}@${server.getHost()}:${server.getPort()}/shop` +
      `?ssl-mode=VERIFY_CA&ssl-ca=${encodeURIComponent(caFile)}&connectTimeout=5000&charset=utf8mb4`;
    const parsed = parseConnectionUrl(url, createDataSourceSettings('mysql'));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.settings.ssl).toMatchObject({ enabled: true, mode: 'verify-ca', caFile });
    const result = await testMysqlConnection(parsed.settings, { password: parsed.password });
    expect(result.serverVersion.product).toBe('MySQL');
  });
});

describe('TLS', () => {
  it('connects with Require and Verify CA', async () => {
    for (const mode of ['require', 'verify-ca'] as const) {
      const settings = appSettings((s) => {
        s.ssl = { enabled: true, mode, caFile, certFile: '', keyFile: '' };
      });
      await expect(testMysqlConnection(settings, { password: APP_PASSWORD })).resolves.toBeDefined();
    }
  });

  it('rejects the auto-generated certificate under Full verification', async () => {
    const settings = appSettings((s) => {
      s.ssl = { enabled: true, mode: 'verify-full', caFile, certFile: '', keyFile: '' };
    });
    await expect(testMysqlConnection(settings, { password: APP_PASSWORD })).rejects.toThrow(/Hostname\/IP does not match|altnames/);
  });

  it('names a missing CA file', async () => {
    const settings = appSettings((s) => {
      s.ssl = { enabled: true, mode: 'verify-ca', caFile: '/missing/ca.pem', certFile: '', keyFile: '' };
    });
    await expect(testMysqlConnection(settings, { password: APP_PASSWORD })).rejects.toThrow('Could not read CA file “/missing/ca.pem”');
  });
});

describe('SSH tunnel', () => {
  it('reaches the server through the SSH host', async () => {
    const settings = appSettings((s) => {
      s.host = 'mysql';
      s.port = '3306';
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
    });
    const result = await testMysqlConnection(settings, { password: APP_PASSWORD, sshPassword: SSH_PASSWORD });
    expect(result.serverVersion.product).toBe('MySQL');
  });

  it('reports a failed SSH login', async () => {
    const settings = appSettings((s) => {
      s.ssh = { enabled: true, host: sshd.getHost(), port: String(sshd.getMappedPort(22)), user: 'root', auth: 'password', privateKeyPath: '' };
    });
    await expect(testMysqlConnection(settings, { password: APP_PASSWORD, sshPassword: 'wrong' })).rejects.toThrow(/^SSH connection to .* failed/);
  });
});

describe('MysqlSession', () => {
  it('lists databases and the objects of one', async () => {
    const session = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    try {
      expect(await session.listDatabases()).toEqual(expect.arrayContaining(['information_schema', 'shop']));
      const objects = await session.listObjects('shop');
      expect(objects.tables.map((t) => t.name)).toEqual(['customers', 'orders', 'samples']);
      expect(objects.tables[0]?.rows).toEqual(expect.any(Number));
      expect(objects).toMatchObject({ views: ['order_totals'], procedures: ['refresh_stats'], functions: ['order_count'] });
    } finally {
      await session.close();
    }
  });

  it('finds objects of every database by name', async () => {
    const session = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    try {
      const inShop = async (text: string) => (await session.searchObjects(text, 100)).filter((m) => m.database === 'shop');
      expect(await inShop('ORDER')).toEqual([
        { database: 'shop', kind: 'function', name: 'order_count', rows: null },
        { database: 'shop', kind: 'view', name: 'order_totals', rows: null },
        { database: 'shop', kind: 'table', name: 'orders', rows: expect.any(Number) },
      ]);
      // LIKE wildcards in the text are matched literally.
      expect((await inShop('_')).map((m) => m.name)).toEqual(['order_count', 'order_totals', 'refresh_stats']);
      expect(await inShop('%')).toEqual([]);
      expect(await session.searchObjects('e', 2)).toHaveLength(2);
    } finally {
      await session.close();
    }
  });

  it('reports a connection killed on the server', async () => {
    const session = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    const closed = new Promise<Error | undefined>((resolve) => session.onDidClose(resolve));
    const root = await mysql.createConnection({ host: server.getHost(), port: server.getPort(), user: 'root', password: 'root-secret' });
    const [rows] = await root.query<mysql.RowDataPacket[]>("SELECT ID FROM information_schema.PROCESSLIST WHERE USER = 'app'");
    for (const row of rows) await root.query(`KILL ${Number(row.ID)}`);
    await root.end();
    expect(await closed).toBeInstanceOf(Error);
  });

  it('reports a normal close without an error', async () => {
    const session = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    const closed = new Promise<Error | undefined>((resolve) => session.onDidClose(resolve));
    await session.close();
    expect(await closed).toBeUndefined();
  });
});

type Session = Awaited<ReturnType<typeof openMysqlSession>>;

async function rowsOf(session: Session, sql: string) {
  const result = await session.execute(sql);
  if (result.kind !== 'rows') throw new Error(`Expected rows from ${sql}`);
  return result;
}

describe('table data', () => {
  let session: Session;
  let samples: TableStructure;
  const page = { where: '', sort: [{ column: 'id', direction: 'asc' as const }], limit: 50, offset: 0 };
  const labels = async () => (await rowsOf(session, buildSelect(samples, page))).rows.map((r) => r[1]);

  beforeAll(async () => {
    session = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    samples = await session.describeTable('shop', 'samples');
  });
  afterAll(() => session?.close());

  it('describes columns, keys and indexes', () => {
    expect(samples).toMatchObject({ kind: 'table', rowKey: ['id'] });
    const byName = Object.fromEntries(samples.columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({ key: 'PRI', autoIncrement: true, numeric: true, nullable: false });
    expect(byName.label).toMatchObject({ defaultValue: 'none', nullable: false, key: 'UNI' });
    expect(byName.status).toMatchObject({ enumValues: ['new', "it's done"], nullable: true, defaultValue: null });
    expect(byName.photo).toMatchObject({ binary: true });
    expect(byName.doubled).toMatchObject({ generated: true });
    expect(byName.created).toMatchObject({ generated: false });
    expect(samples.indexes).toEqual([
      { name: 'PRIMARY', kind: 'PRIMARY', unique: true, columns: ['id'], lengths: [null] },
      { name: 'uq_label', kind: 'UNIQUE', unique: true, columns: ['label'], lengths: [null] },
    ]);
  });

  it('describes a view without a row key and rejects unknown tables', async () => {
    expect(await session.describeTable('shop', 'order_totals')).toMatchObject({ kind: 'view', rowKey: [] });
    await expect(session.describeTable('shop', 'nope')).rejects.toThrow('Table “shop.nope” does not exist.');
  });

  it('pages rows with server values as text', async () => {
    const result = await rowsOf(session, buildSelect(samples, page));
    expect(result.fields.map((f) => f.name)).toEqual(['id', 'label', 'status', 'payload', 'photo', 'amount', 'created', 'doubled']);
    expect(result.fields.map((f) => f.type)).toEqual(['bigint', 'varchar', 'char', 'json', 'blob', 'decimal', 'datetime', 'decimal']);
    expect(result.fields.map((f) => [f.numeric, f.binary])).toEqual([
      [true, false],
      [false, false],
      [false, false],
      [false, false],
      [false, true],
      [true, false],
      [false, false],
      [true, false],
    ]);
    const [first] = result.rows as unknown[][];
    expect(first?.slice(0, 4)).toEqual(['1', 'first', 'new', '{"a": 1}']);
    expect(first?.[4]).toEqual(Buffer.from([0xca, 0xfe]));
    expect(first?.slice(5)).toEqual(['12.50', '2026-10-24 09:14:02', '25.00']);
    const count = await rowsOf(session, buildCount(samples, "label = 'second'"));
    expect(Number(count.rows[0]?.[0])).toBe(1);
  });

  it('writes grid changes in one transaction', async () => {
    const loaded = (await rowsOf(session, buildSelect(samples, page))).rows;
    const statements = buildChanges(
      samples,
      [
        { kind: 'update', row: 1, values: { status: "it's done", amount: '3.10' } },
        { kind: 'insert', values: { label: 'third' } },
      ],
      (row) => [loaded[row]?.[0]],
    );
    expect(await session.write(statements, true)).toEqual([1, 1]);
    expect(await labels()).toEqual(['first', 'second', 'third']);
    expect(session.format(statements[0]!)).toBe(
      "UPDATE `shop`.`samples` SET `status` = 'it\\'s done', `amount` = '3.10' WHERE `id` = '2' LIMIT 1",
    );
  });

  it('undoes the whole write when a row no longer matches', async () => {
    const statements = buildChanges(
      samples,
      [
        { kind: 'insert', values: { label: 'fourth' } },
        { kind: 'delete', row: 0 },
      ],
      () => ['999'],
    );
    await expect(session.write(statements, true)).rejects.toThrow(/changed or deleted by someone else/);
    expect(await labels()).toEqual(['first', 'second', 'third']);
    expect(session.inTransaction).toBe(false);
  });

  it('keeps a manual transaction open until commit or rollback', async () => {
    const other = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    try {
      const insert = (label: string) => buildChanges(samples, [{ kind: 'insert', values: { label } }], () => []);
      await session.write(insert('pending'), false);
      expect(session.inTransaction).toBe(true);
      expect(await labels()).toContain('pending');
      expect((await rowsOf(other, buildSelect(samples, page))).rows.map((r) => r[1])).not.toContain('pending');
      await session.rollback();
      expect(await labels()).not.toContain('pending');

      await session.write(insert('kept'), false);
      await expect(session.write(insert('kept'), false)).rejects.toThrow(/Duplicate entry/);
      expect(session.inTransaction).toBe(true);
      await session.commit();
      expect((await rowsOf(other, buildSelect(samples, page))).rows.map((r) => r[1])).toContain('kept');
    } finally {
      await other.close();
    }
  });

  it('streams rows one at a time', async () => {
    const seen: unknown[][] = [];
    let names: string[] = [];
    const count = await session.streamRows(
      'SELECT id, label FROM shop.samples ORDER BY id',
      (fields) => void (names = fields.map((f) => f.name)),
      async (row) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen.push(row);
      },
    );
    expect(names).toEqual(['id', 'label']);
    expect(count).toBe(seen.length);
    expect(seen[0]).toEqual(['1', 'first']);
    expect(await session.streamRows('SELECT id FROM shop.samples WHERE 1 = 0', (f) => void (names = f.map((x) => x.name)), () => {})).toBe(0);
    expect(names).toEqual(['id']);
  });

  it('stops a running query from another session', async () => {
    const other = await openMysqlSession(appSettings(), { password: APP_PASSWORD });
    try {
      const started = Date.now();
      const running = other.execute('SELECT SLEEP(20)');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await session.stopQuery(other.connectionId);
      await running.catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await other.close();
    }
  });

  it('reports which table column each result column comes from', async () => {
    const result = await rowsOf(session, 'SELECT s.id, s.label AS name, 1 + 1 AS two FROM shop.samples s ORDER BY s.id LIMIT 1');
    expect(result.fields.map((f) => [f.name, f.source])).toEqual([
      ['id', { database: 'shop', table: 'samples', column: 'id' }],
      ['name', { database: 'shop', table: 'samples', column: 'label' }],
      ['two', null],
    ]);
    const joined = await rowsOf(session, 'SELECT c.name, o.total FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.id');
    expect(joined.fields.map((f) => f.source?.table)).toEqual(['customers', 'orders']);
  });

  it('runs writes and follows transactions opened by the script', async () => {
    const insert = await session.execute("INSERT INTO shop.samples (label) VALUES ('scripted')");
    expect(insert).toMatchObject({ kind: 'ok', affectedRows: 1 });
    expect(session.inTransaction).toBe(false);
    await session.execute('START TRANSACTION');
    expect(session.inTransaction).toBe(true);
    await session.execute("DELETE FROM shop.samples WHERE label = 'scripted'");
    expect(session.inTransaction).toBe(true);
    await session.execute('ROLLBACK');
    expect(session.inTransaction).toBe(false);
    expect(await labels()).toContain('scripted');
    await session.begin();
    await session.execute("DELETE FROM shop.samples WHERE label = 'scripted'");
    await session.commit();
    expect(await labels()).not.toContain('scripted');
  });

  it('shows the DDL of tables and views', async () => {
    expect(await session.showCreate('shop', 'samples', 'table')).toMatch(/^CREATE TABLE `samples`/);
    expect(await session.showCreate('shop', 'order_totals', 'view')).toMatch(/VIEW `order_totals` AS/);
  });
});

describe.each(['MySQL', 'MariaDB'] as const)('structure changes on %s', (product) => {
  let session: Session;
  const describeProbe = () => session.describeTable('shop', 'probe');

  beforeAll(async () => {
    const target = product === 'MySQL' ? server : mariadb;
    session = await openMysqlSession(
      appSettings((s) => {
        s.host = target.getHost();
        s.port = String(target.getPort());
      }),
      { password: APP_PASSWORD },
    );
    await session.execute(`CREATE TABLE shop.probe (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TRY' COMMENT 'it''s code',
      upd TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      n DECIMAL(5,2) DEFAULT 0 CHECK (n >= 0),
      g DECIMAL(6,2) AS (n * 2) STORED,
      customer_id INT NULL,
      note VARCHAR(20) NULL,
      INDEX pfx (code(2), note),
      CONSTRAINT fk_probe_customer FOREIGN KEY (customer_id) REFERENCES shop.customers (id) ON DELETE SET NULL,
      CONSTRAINT chk_n CHECK (n < 1000)
    ) COMMENT 'probe table' AUTO_INCREMENT = 50`);
  });
  afterAll(async () => {
    await session?.execute('DROP TABLE IF EXISTS shop.probe, shop.probe_renamed');
    await session?.close();
  });

  it('reads defaults as SQL, collations, ON UPDATE, generation, index prefixes and foreign keys', async () => {
    const probe = await describeProbe();
    const byName = Object.fromEntries(probe.columns.map((c) => [c.name, c]));
    expect(byName.code).toMatchObject({ defaultSql: "'TRY'", charset: 'ascii', collation: 'ascii_bin', comment: "it's code" });
    expect(byName.upd?.defaultSql).toMatch(/^current_timestamp(\(\))?$/i);
    expect(byName.upd?.onUpdate).toMatch(/^current_timestamp(\(\))?$/i);
    expect(byName.n?.defaultSql).toBe('0.00');
    expect(byName.note?.defaultSql).toBe('NULL');
    expect(byName.g).toMatchObject({ defaultSql: null, generation: { stored: true } });
    expect(probe.indexes.find((i) => i.name === 'pfx')).toMatchObject({ kind: 'INDEX', columns: ['code', 'note'], lengths: [2, null] });
    // An ON UPDATE that was not given reads as NO ACTION on MySQL and RESTRICT on MariaDB.
    expect(probe.foreignKeys).toEqual([
      {
        name: 'fk_probe_customer',
        columns: ['customer_id'],
        refDatabase: 'shop',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: product === 'MySQL' ? 'NO ACTION' : 'RESTRICT',
        onDelete: 'SET NULL',
      },
    ]);
    expect(probe.options).toMatchObject({ comment: 'probe table', engine: 'InnoDB', charset: 'utf8mb4', autoIncrement: 50 });
    // MySQL turns a column CHECK into a table constraint; MariaDB keeps it with the column.
    if (product === 'MySQL') expect(probe.checks.map((c) => c.name)).toEqual(['chk_n', 'probe_chk_1']);
    else {
      expect(probe.checks.map((c) => c.name)).toEqual(['chk_n']);
      expect(byName.n?.check).toBe('`n` >= 0');
    }
    expect(buildAlterTable(probe, draftOf(probe))).toEqual([]);
  });

  it('lists engines, character sets and collations', async () => {
    const choices = await session.tableOptionChoices();
    expect(choices.engines).toContain('InnoDB');
    expect(choices.charsets).toContainEqual({ name: 'ascii', defaultCollation: 'ascii_general_ci' });
    expect(choices.collations).toContainEqual({ name: 'utf8mb4_bin', charset: 'utf8mb4' });
  });

  it('applies edits to columns, indexes and foreign keys and keeps what the tab does not show', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    const column = (name: string) => draft.columns.find((c) => c.original === name)!;
    column('note').name = 'remark';
    column('note').type = 'varchar(40)';
    column('code').comment = 'ISO currency';
    const n = draft.columns.splice(draft.columns.indexOf(column('n')), 1)[0]!;
    draft.columns.splice(1, 0, n);
    draft.columns.splice(3, 0, { original: null, name: 'flag', type: 'tinyint', nullable: false, defaultSql: '0', autoIncrement: false, comment: '', dropped: false });
    draft.indexes.find((i) => i.name === 'pfx')!.dropped = true;
    draft.indexes.push({ original: null, kind: 'UNIQUE', name: 'uq_remark', columns: 'remark', dropped: false });
    draft.foreignKeys[0]!.onDelete = 'CASCADE';

    for (const sql of buildAlterTable(before, draft)) await session.execute(sql);

    const after = await describeProbe();
    expect(after.columns.map((c) => c.name)).toEqual(['id', 'n', 'code', 'flag', 'upd', 'g', 'customer_id', 'remark']);
    const byName = Object.fromEntries(after.columns.map((c) => [c.name, c]));
    expect(byName.code).toMatchObject({ charset: 'ascii', collation: 'ascii_bin', comment: 'ISO currency', defaultSql: "'TRY'" });
    expect(byName.remark).toMatchObject({ columnType: 'varchar(40)', nullable: true });
    expect(byName.flag).toMatchObject({ nullable: false, defaultSql: '0' });
    expect(byName.upd?.onUpdate).toMatch(/^current_timestamp(\(\))?$/i);
    expect(byName.g?.generation?.stored).toBe(true);
    if (product === 'MariaDB') expect(byName.n?.check).toBe('`n` >= 0');
    else expect(after.checks.map((c) => c.name)).toContain('probe_chk_1');
    expect(after.indexes.map((i) => i.name)).not.toContain('pfx');
    expect(after.indexes.find((i) => i.name === 'uq_remark')).toMatchObject({ kind: 'UNIQUE', columns: ['remark'] });
    expect(after.foreignKeys[0]).toMatchObject({ name: 'fk_probe_customer', onDelete: 'CASCADE' });
    expect(buildAlterTable(after, draftOf(after))).toEqual([]);
  });

  it('drops columns and the primary key', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    draft.columns.find((c) => c.original === 'flag')!.dropped = true;
    draft.indexes.find((i) => i.kind === 'PRIMARY')!.columns = 'id, code';
    for (const sql of buildAlterTable(before, draft)) await session.execute(sql);
    const after = await describeProbe();
    expect(after.columns.map((c) => c.name)).not.toContain('flag');
    expect(after.indexes.find((i) => i.kind === 'PRIMARY')?.columns).toEqual(['id', 'code']);
    expect(after.rowKey).toEqual(['id', 'code']);
  });

  it('changes table options and CHECK constraints and renames the table', async () => {
    const before = await describeProbe();
    const draft = draftOf(before);
    draft.table!.comment = "Probe's table";
    draft.table!.collation = 'utf8mb4_bin';
    draft.table!.autoIncrement = '500';
    draft.table!.name = 'probe_renamed';
    draft.checks.find((c) => c.name === 'chk_n')!.dropped = true;
    draft.checks.push({ original: null, name: 'chk_n_floor', clause: 'n > -1', dropped: false });
    for (const sql of buildAlterTable(before, draft)) await session.execute(sql);

    await expect(describeProbe()).rejects.toThrow('does not exist');
    const after = await session.describeTable('shop', 'probe_renamed');
    expect(after.options).toMatchObject({ comment: "Probe's table", collation: 'utf8mb4_bin', charset: 'utf8mb4', autoIncrement: 500 });
    expect(after.checks.map((c) => c.name)).toContain('chk_n_floor');
    expect(after.checks.map((c) => c.name)).not.toContain('chk_n');
    // Changing only the default leaves the columns' own collation alone.
    expect(after.columns.find((c) => c.name === 'code')?.collation).toBe('ascii_bin');

    const convert = draftOf(after);
    convert.table!.convert = true;
    for (const sql of buildAlterTable(after, convert)) await session.execute(sql);
    const converted = await session.describeTable('shop', 'probe_renamed');
    expect(converted.columns.find((c) => c.name === 'code')?.collation).toBe('utf8mb4_bin');
  });
});

describe('MariaDB', () => {
  it('connects and lists objects with the same adapter', async () => {
    const settings = appSettings((s) => {
      s.driver = 'mariadb';
      s.host = mariadb.getHost();
      s.port = String(mariadb.getPort());
    });
    const result = await testMysqlConnection(settings, { password: APP_PASSWORD });
    expect(result.serverVersion).toMatchObject({ product: 'MariaDB', version: expect.stringMatching(/^11\.4\.\d+$/) });

    const session = await openMysqlSession(settings, { password: APP_PASSWORD });
    try {
      expect(await session.listObjects('shop')).toMatchObject({
        views: ['order_totals'],
        procedures: ['refresh_stats'],
        functions: ['order_count'],
      });
      const samples = await session.describeTable('shop', 'samples');
      const byName = Object.fromEntries(samples.columns.map((c) => [c.name, c]));
      expect(byName.label?.defaultValue).toBe("'none'");
      expect(byName.status?.defaultValue).toBeNull();
      expect(byName.doubled?.generated).toBe(true);
      expect(samples.rowKey).toEqual(['id']);
    } finally {
      await session.close();
    }
  });
});
