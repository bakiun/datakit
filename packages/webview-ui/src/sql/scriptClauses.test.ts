import { describe, expect, it } from 'vitest';
import { applyPaging, readPaging, unpaged, withoutLimit } from './scriptClauses';

const generated = 'SELECT *\nFROM `shop`.`orders`\nORDER BY `id` ASC\nLIMIT 25 OFFSET 0';

describe('readPaging', () => {
  it('reads plain column sorts and every LIMIT form', () => {
    expect(readPaging(generated, 'mysql')).toEqual({ sort: [{ column: 'id', direction: 'asc' }], limit: 25, offset: 0 });
    expect(readPaging('SELECT * FROM t ORDER BY o.total DESC, `first name` LIMIT 20, 10', 'mysql')).toEqual({
      sort: [
        { column: 'total', direction: 'desc' },
        { column: 'first name', direction: 'asc' },
      ],
      limit: 10,
      offset: 20,
    });
    expect(readPaging('select 1', 'mysql')).toEqual({ sort: [], limit: null, offset: 0 });
  });

  it('treats expressions in ORDER BY as a custom sort', () => {
    expect(readPaging('SELECT * FROM t ORDER BY LENGTH(name) DESC LIMIT 5', 'mysql').sort).toBeNull();
  });

  it('ignores clauses inside subqueries and strings', () => {
    const text = "SELECT * FROM (SELECT id FROM x ORDER BY id LIMIT 3) z WHERE a = 'ORDER BY b LIMIT 9'";
    expect(readPaging(text, 'mysql')).toEqual({ sort: [], limit: null, offset: 0 });
  });
});

describe('applyPaging', () => {
  it('replaces only the clauses it is given', () => {
    expect(applyPaging(generated, 'mysql', { offset: 25 })).toBe('SELECT *\nFROM `shop`.`orders`\nORDER BY `id` ASC\nLIMIT 25 OFFSET 25');
    expect(applyPaging(generated, 'mysql', { sort: [{ column: 'total', direction: 'desc' }], offset: 0 })).toBe(
      'SELECT *\nFROM `shop`.`orders`\nORDER BY `total` DESC\nLIMIT 25 OFFSET 0',
    );
  });

  it('removes the ORDER BY when the sort is cleared', () => {
    expect(applyPaging(generated, 'mysql', { sort: [] })).toBe('SELECT *\nFROM `shop`.`orders`\nLIMIT 25 OFFSET 0');
  });

  it('adds missing clauses in the right order, keeping the rest of the text', () => {
    const text = "-- totals\nSELECT c.name, SUM(o.total) AS total\nFROM customers c JOIN orders o ON o.customer_id = c.id\nGROUP BY c.name";
    expect(applyPaging(text, 'mysql', { sort: [{ column: 'total', direction: 'desc' }], limit: 50, offset: 0 })).toBe(
      `${text}\nORDER BY \`total\` DESC\nLIMIT 50 OFFSET 0`,
    );
    expect(applyPaging('SELECT * FROM t LIMIT 5', 'mysql', { sort: [{ column: 'a', direction: 'asc' }] })).toBe(
      'SELECT * FROM t ORDER BY `a` ASC LIMIT 5',
    );
  });

  it('keeps FOR UPDATE after the clauses it adds', () => {
    expect(applyPaging('SELECT * FROM t WHERE a = 1 FOR UPDATE', 'mysql', { limit: 10, offset: 0 })).toBe(
      'SELECT * FROM t WHERE a = 1 LIMIT 10 OFFSET 0 FOR UPDATE',
    );
  });

  it('leaves comments after the query in place', () => {
    expect(applyPaging('SELECT * FROM t -- all rows', 'mysql', { limit: 10, offset: 0 })).toBe('SELECT * FROM t LIMIT 10 OFFSET 0 -- all rows');
  });
});

describe('unpaged', () => {
  it('drops ORDER BY and LIMIT for counting', () => {
    expect(unpaged(generated, 'mysql')).toBe('SELECT *\nFROM `shop`.`orders`');
    expect(unpaged('SELECT * FROM t WHERE a = 1 ORDER BY b LIMIT 5 -- note', 'mariadb')).toBe('SELECT * FROM t WHERE a = 1');
  });
});

describe('PostgreSQL', () => {
  const pg = 'SELECT *\nFROM "public"."orders"\nORDER BY "id" ASC\nLIMIT 25 OFFSET 0';

  it('reads and writes double-quoted names', () => {
    expect(readPaging('SELECT * FROM t ORDER BY "First Name" DESC, o.total LIMIT 10 OFFSET 20', 'postgres')).toEqual({
      sort: [
        { column: 'First Name', direction: 'desc' },
        { column: 'total', direction: 'asc' },
      ],
      limit: 10,
      offset: 20,
    });
    expect(applyPaging(pg, 'postgres', { sort: [{ column: 'Total "net"', direction: 'desc' }], offset: 25 })).toBe(
      'SELECT *\nFROM "public"."orders"\nORDER BY "Total ""net""" DESC\nLIMIT 25 OFFSET 25',
    );
  });

  it('folds an OFFSET of its own into the LIMIT clause', () => {
    expect(readPaging('SELECT * FROM t OFFSET 40 LIMIT 20', 'postgres')).toEqual({ sort: [], limit: 20, offset: 40 });
    expect(readPaging('SELECT * FROM t ORDER BY a OFFSET 5', 'postgres')).toEqual({ sort: [{ column: 'a', direction: 'asc' }], limit: null, offset: 5 });
    expect(applyPaging('SELECT * FROM t OFFSET 40 LIMIT 20', 'postgres', { offset: 60 })).toBe('SELECT * FROM t LIMIT 20 OFFSET 60');
    expect(applyPaging('SELECT * FROM t ORDER BY a OFFSET 5', 'postgres', { limit: 10 })).toBe('SELECT * FROM t ORDER BY a LIMIT 10 OFFSET 5');
    expect(applyPaging('SELECT * FROM t OFFSET 5', 'postgres', { sort: [{ column: 'b', direction: 'asc' }] })).toBe('SELECT * FROM t ORDER BY "b" ASC OFFSET 5');
    expect(applyPaging('SELECT * FROM t LIMIT ALL', 'postgres', { limit: 10, offset: 0 })).toBe('SELECT * FROM t LIMIT 10 OFFSET 0');
  });

  it('leaves dollar-quoted text alone and drops paging for counts and exports', () => {
    const text = "SELECT $$ORDER BY x LIMIT 9$$ AS note FROM t WHERE a = 'LIMIT 3' ORDER BY id OFFSET 2 LIMIT 4 FOR UPDATE";
    expect(readPaging(text, 'postgres')).toEqual({ sort: [{ column: 'id', direction: 'asc' }], limit: 4, offset: 2 });
    expect(unpaged(text, 'postgres')).toBe("SELECT $$ORDER BY x LIMIT 9$$ AS note FROM t WHERE a = 'LIMIT 3'    FOR UPDATE");
    expect(withoutLimit(pg, 'postgres')).toBe('SELECT *\nFROM "public"."orders"\nORDER BY "id" ASC');
  });
});

describe('withoutLimit', () => {
  it('keeps ORDER BY and drops LIMIT', () => {
    expect(withoutLimit(generated, 'mysql')).toBe('SELECT *\nFROM `shop`.`orders`\nORDER BY `id` ASC');
    expect(withoutLimit('SELECT 1', 'mysql')).toBe('SELECT 1');
  });
});
