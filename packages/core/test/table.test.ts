import { describe, expect, it } from 'vitest';
import {
  buildChanges,
  buildCount,
  buildSelect,
  describeChanges,
  isEditableColumn,
  parseEnumValues,
  quoteIdentifier,
  readOnlyReason,
  type ColumnInfo,
  type TableStructure,
} from '../src';

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
    defaultSql: null,
    comment: '',
    charset: null,
    collation: null,
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
  options: { comment: '', engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci', autoIncrement: 1 },
  checks: [],
  columns: [column('id', { key: 'PRI', autoIncrement: true, numeric: true }), column('status'), column('total', { numeric: true })],
  indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', unique: true, columns: ['id'], lengths: [null] }],
  foreignKeys: [],
  rowKey: ['id'],
};

describe('SELECT and COUNT', () => {
  it('builds the paged query one clause per line', () => {
    expect(buildSelect(orders, { where: '', sort: [], limit: 25, offset: 0 })).toBe('SELECT *\nFROM `shop`.`orders`\nLIMIT 25 OFFSET 0;');
    expect(
      buildSelect(orders, {
        where: " status = 'paid' ",
        sort: [
          { column: 'total', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        limit: 10,
        offset: 20,
      }),
    ).toBe("SELECT *\nFROM `shop`.`orders`\nWHERE status = 'paid'\nORDER BY `total` DESC, `id` ASC\nLIMIT 10 OFFSET 20;");
  });

  it('counts with the same condition', () => {
    expect(buildCount(orders, "status = 'paid'")).toBe("SELECT COUNT(*) AS total FROM `shop`.`orders` WHERE status = 'paid'");
    expect(buildCount(orders, ' ')).toBe('SELECT COUNT(*) AS total FROM `shop`.`orders`');
  });

  it('quotes identifiers with backticks', () => {
    expect(quoteIdentifier('we`ird', 'mysql')).toBe('`we``ird`');
  });
});

describe('buildChanges', () => {
  const keyOf = (row: number) => [100 + row];

  it('writes updates, inserts and deletes with parameters', () => {
    const statements = buildChanges(
      orders,
      [
        { kind: 'update', row: 0, values: { status: 'paid', total: null } },
        { kind: 'insert', values: { status: 'new' } },
        { kind: 'insert', values: {} },
        { kind: 'delete', row: 2 },
      ],
      keyOf,
    );
    expect(statements).toEqual([
      { sql: 'UPDATE `shop`.`orders` SET `status` = ?, `total` = ? WHERE `id` = ? LIMIT 1', params: ['paid', null, 100], expectedRows: 1 },
      { sql: 'INSERT INTO `shop`.`orders` (`status`) VALUES (?)', params: ['new'] },
      { sql: 'INSERT INTO `shop`.`orders` () VALUES ()', params: [] },
      { sql: 'DELETE FROM `shop`.`orders` WHERE `id` = ? LIMIT 1', params: [102], expectedRows: 1 },
    ]);
  });

  it('matches every column of a composite key', () => {
    const items = { ...orders, rowKey: ['order_id', 'line'] };
    expect(buildChanges(items, [{ kind: 'delete', row: 0 }], () => [7, 2])[0]).toEqual({
      sql: 'DELETE FROM `shop`.`orders` WHERE `order_id` = ? AND `line` = ? LIMIT 1',
      params: [7, 2],
      expectedRows: 1,
    });
  });

  it('summarises a change set', () => {
    expect(describeChanges([{ kind: 'update', row: 0, values: {} }, { kind: 'update', row: 1, values: {} }, { kind: 'delete', row: 2 }])).toBe(
      '2 updated · 1 deleted',
    );
    expect(describeChanges([])).toBe('no changes');
  });
});

describe('editing rules', () => {
  it('explains read-only grids', () => {
    expect(readOnlyReason(orders)).toBeNull();
    expect(readOnlyReason({ ...orders, kind: 'view' })).toBe('Views are shown read-only.');
    expect(readOnlyReason({ ...orders, rowKey: [] })).toMatch(/no primary key/);
  });

  it('keeps keys of existing rows, generated and binary columns read-only', () => {
    const [id, status] = orders.columns as [ColumnInfo, ColumnInfo];
    expect(isEditableColumn(id, orders.rowKey, true)).toBe(false);
    expect(isEditableColumn(id, orders.rowKey, false)).toBe(true);
    expect(isEditableColumn(status, orders.rowKey, true)).toBe(true);
    expect(isEditableColumn(column('total2', { generated: true }), orders.rowKey, false)).toBe(false);
    expect(isEditableColumn(column('photo', { binary: true }), orders.rowKey, true)).toBe(false);
  });

  it('reads ENUM values', () => {
    expect(parseEnumValues("enum('pending','it''s','shipped')")).toEqual(['pending', "it's", 'shipped']);
    expect(parseEnumValues('varchar(20)')).toBeNull();
  });
});
