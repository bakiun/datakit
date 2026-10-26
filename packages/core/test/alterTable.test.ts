import { describe, expect, it } from 'vitest';
import { buildAlterTable, countDraftChanges, draftOf, mapColumnList, validateDraft, type ColumnInfo, type StructureDraft, type TableStructure } from '../src';

function column(name: string, patch: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    columnType: 'varchar(50)',
    dataType: 'varchar',
    nullable: true,
    defaultValue: null,
    key: '',
    extra: '',
    autoIncrement: false,
    generated: false,
    numeric: false,
    binary: false,
    enumValues: null,
    defaultSql: 'NULL',
    comment: '',
    charset: 'utf8mb4',
    collation: 'utf8mb4_0900_ai_ci',
    onUpdate: null,
    generation: null,
    check: null,
    ...patch,
  };
}

const orders: TableStructure = {
  dialect: 'mysql',
  database: 'shop',
  table: 'orders',
  kind: 'table',
  options: { comment: 'Orders', engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', autoIncrement: 50 },
  checks: [{ name: 'chk_total', clause: '(`total2` >= 0)' }],
  columns: [
    column('id', { columnType: 'int', dataType: 'int', nullable: false, defaultSql: null, autoIncrement: true, key: 'PRI', charset: null, collation: null }),
    column('email', { nullable: false, defaultSql: null }),
    column('status', { columnType: "enum('new','paid')", defaultSql: "'new'", comment: "it's set" }),
    column('updated', { columnType: 'timestamp', dataType: 'timestamp', defaultSql: 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP', charset: null, collation: null }),
    column('total2', { columnType: 'decimal(10,2)', defaultSql: null, generation: { expression: '(`total` * 2)', stored: true }, charset: null, collation: null }),
  ],
  indexes: [
    { name: 'PRIMARY', kind: 'PRIMARY', unique: true, columns: ['id'], lengths: [null] },
    { name: 'idx_email', kind: 'INDEX', unique: false, columns: ['email', 'status'], lengths: [10, null] },
  ],
  foreignKeys: [
    { name: 'fk_customer', columns: ['email'], refDatabase: 'shop', refTable: 'customers', refColumns: ['email'], onUpdate: 'RESTRICT', onDelete: 'CASCADE' },
  ],
  rowKey: ['id'],
};

function edit(change: (d: StructureDraft) => void): StructureDraft {
  const draft = draftOf(orders);
  change(draft);
  return draft;
}

describe('draftOf', () => {
  it('shows index prefixes and foreign key targets as text', () => {
    const draft = draftOf(orders);
    expect(draft.indexes[1]?.columns).toBe('email(10), status');
    expect(draft.foreignKeys[0]).toMatchObject({ refTable: 'customers', columns: 'email', refColumns: 'email' });
    expect(buildAlterTable(orders, draft)).toEqual([]);
    expect(countDraftChanges(orders, draft)).toBe(0);
  });
});

describe('buildAlterTable', () => {
  it('changes a column and keeps what the tab does not show', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.columns[2]!.name = 'state';
        d.indexes[1]!.columns = 'email(10), state'; // as the tab updates it on rename
        d.columns[2]!.nullable = false;
        d.columns[3]!.comment = 'Last change';
      }),
    );
    expect(sql).toEqual([
      "ALTER TABLE `shop`.`orders`\n" +
        "  CHANGE COLUMN `status` `state` enum('new','paid') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'new' COMMENT 'it''s set',\n" +
        "  CHANGE COLUMN `updated` `updated` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last change'",
    ]);
  });

  it('adds, drops and moves columns with their positions', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        const [id, email, status, updated, total2] = d.columns as [never, never, never, never, never];
        d.columns = [id, status, email, updated, total2];
        d.columns.splice(1, 0, { original: null, name: 'note', type: 'text', nullable: true, defaultSql: '', autoIncrement: false, comment: '', dropped: false });
        d.columns[4]!.dropped = true;
      }),
    )[0]!;
    expect(sql.split('\n').slice(1)).toEqual([
      '  DROP COLUMN `updated`,',
      '  ADD COLUMN `note` text NULL AFTER `id`,',
      // Moving the fewest columns: `email` goes behind `status`, which gives id, note, status, email, total2.
      '  CHANGE COLUMN `email` `email` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL AFTER `status`',
    ]);
  });

  it('keeps the expression of a generated column', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.columns[4]!.type = 'decimal(12,2)';
      }),
    )[0]!;
    expect(sql).toContain('CHANGE COLUMN `total2` `total2` decimal(12,2) GENERATED ALWAYS AS ((`total` * 2)) STORED NULL');
  });

  it('drops and adds indexes, primary keys included', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.indexes[0]!.columns = 'id, email';
        d.indexes[1]!.dropped = true;
        d.indexes.push({ original: null, kind: 'UNIQUE', name: 'uq_email', columns: 'email', dropped: false });
        d.indexes.push({ original: null, kind: 'FULLTEXT', name: 'ft_status', columns: 'status', dropped: false });
      }),
    )[0]!;
    expect(sql.split('\n').slice(1)).toEqual([
      '  DROP PRIMARY KEY,',
      '  DROP INDEX `idx_email`,',
      '  ADD PRIMARY KEY (`id`, `email`),',
      '  ADD UNIQUE INDEX `uq_email` (`email`),',
      '  ADD FULLTEXT INDEX `ft_status` (`status`)',
    ]);
  });

  it('changes foreign keys in statements of their own', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.foreignKeys[0]!.onDelete = 'SET NULL';
        d.columns[1]!.comment = 'login';
      }),
    );
    expect(sql).toHaveLength(3);
    expect(sql[0]).toBe('ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `fk_customer`');
    expect(sql[1]).toContain('CHANGE COLUMN `email`');
    expect(sql[2]).toBe(
      'ALTER TABLE `shop`.`orders`\n  ADD CONSTRAINT `fk_customer` FOREIGN KEY (`email`) REFERENCES `shop`.`customers` (`email`) ON DELETE SET NULL ON UPDATE RESTRICT',
    );
  });

  it('leaves indexes and keys alone when only a column they use is renamed', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.columns[1]!.name = 'mail';
        d.indexes[1]!.columns = 'mail(10), status';
        d.foreignKeys[0]!.columns = 'mail';
      }),
    );
    expect(sql).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `email` `mail` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL',
    ]);
  });

  it('changes table options after the columns, and renames the table last', () => {
    const sql = buildAlterTable(
      orders,
      edit((d) => {
        d.table!.name = 'purchases';
        d.table!.comment = "Customer's orders";
        d.table!.engine = 'MyISAM';
        d.table!.charset = 'latin1';
        d.table!.collation = 'latin1_swedish_ci';
        d.table!.convert = true;
        d.table!.autoIncrement = '1000';
        d.columns[1]!.comment = 'login';
      }),
    );
    expect(sql).toEqual([
      expect.stringContaining('CHANGE COLUMN `email`'),
      "ALTER TABLE `shop`.`orders`\n  ENGINE = MyISAM,\n  CONVERT TO CHARACTER SET latin1 COLLATE latin1_swedish_ci,\n  COMMENT = 'Customer''s orders',\n  AUTO_INCREMENT = 1000",
      'RENAME TABLE `shop`.`orders` TO `shop`.`purchases`',
    ]);
  });

  it('changes only the default character set unless asked to convert', () => {
    const sql = buildAlterTable(orders, edit((d) => (d.table!.collation = 'utf8mb4_bin')));
    expect(sql).toEqual(['ALTER TABLE `shop`.`orders`\n  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin']);
  });

  it('drops, changes and adds CHECK constraints in the dialect of the server', () => {
    const draft = edit((d) => {
      d.checks[0]!.clause = 'total2 > 0';
      d.checks.push({ original: null, name: 'chk_email', clause: "email LIKE '%@%'", dropped: false });
    });
    expect(buildAlterTable(orders, draft)).toEqual([
      "ALTER TABLE `shop`.`orders`\n  DROP CHECK `chk_total`,\n  ADD CONSTRAINT `chk_total` CHECK (total2 > 0),\n  ADD CONSTRAINT `chk_email` CHECK (email LIKE '%@%')",
    ]);
    expect(buildAlterTable({ ...orders, dialect: 'mariadb' }, draft)[0]).toContain('DROP CONSTRAINT `chk_total`');
  });

  it('keeps a MariaDB column check when the column changes', () => {
    const mariadb: TableStructure = { ...orders, dialect: 'mariadb', columns: orders.columns.map((c) => (c.name === 'email' ? { ...c, check: "`email` like '%@%'" } : c)) };
    const draft = draftOf(mariadb);
    draft.columns[1]!.comment = 'login';
    expect(buildAlterTable(mariadb, draft)[0]).toContain("COMMENT 'login' CHECK (`email` like '%@%')");
  });

  it('counts changed rows', () => {
    const draft = edit((d) => {
      d.columns[1]!.comment = 'x';
      d.indexes[1]!.dropped = true;
      d.columns.reverse();
    });
    expect(countDraftChanges(orders, draft)).toBe(3);
  });
});

describe('mapColumnList', () => {
  it('renames columns and keeps lengths and order', () => {
    expect(mapColumnList('email(10) DESC, `status`', (n) => (n === 'email' ? 'mail' : n))).toBe('mail(10) DESC, status');
  });
});

describe('validateDraft', () => {
  it('requires unique names and known columns', () => {
    const errors = validateDraft(
      orders,
      edit((d) => {
        d.columns[3]!.name = 'ID';
        d.columns[4]!.type = ' ';
        d.indexes[1]!.columns = 'email, nope';
        d.indexes.push({ original: null, kind: 'INDEX', name: '', columns: 'id', dropped: false });
        d.foreignKeys[0]!.refColumns = 'a, b';
      }),
    );
    expect(errors).toEqual({
      'columns.3.name': 'Another column is named “ID”.',
      'columns.4.type': 'Column type is required.',
      'indexes.1.columns': 'There is no column “nope”.',
      'indexes.2.name': 'Index name is required.',
      'foreignKeys.0.refColumns': 'Reference as many columns as the key has.',
    });
  });

  it('checks the table name, AUTO_INCREMENT and CHECK constraints', () => {
    const errors = validateDraft(
      orders,
      edit((d) => {
        d.table!.name = ' ';
        d.table!.autoIncrement = 'soon';
        d.checks.push({ original: null, name: 'CHK_TOTAL', clause: '', dropped: false });
      }),
    );
    expect(errors).toEqual({
      'table.name': 'Table name is required.',
      'table.autoIncrement': 'AUTO_INCREMENT must be a whole number.',
      'checks.1.name': 'Another check is named “CHK_TOTAL”.',
      'checks.1.clause': 'Condition is required.',
    });
  });

  it('allows one primary key and at least one column', () => {
    expect(validateDraft(orders, edit((d) => d.indexes.push({ original: null, kind: 'PRIMARY', name: 'PRIMARY', columns: 'email', dropped: false })))).toEqual({
      indexes: 'A table can have only one primary key.',
    });
    expect(validateDraft(orders, edit((d) => d.columns.forEach((c) => (c.dropped = true))))).toMatchObject({ columns: 'A table needs at least one column.' });
  });
});
