import { describe, expect, it } from 'vitest';
import { changesData, isExplainable, isPageableQuery, leadingKeyword, splitSqlScript, splitSqlStatements } from '../src';

describe('splitSqlScript', () => {
  it('returns each statement with its place in the script', () => {
    const script = "-- first\nUPDATE t SET a = 1;\n\nSELECT 'x;y'\nFROM t;\nDELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //\nDELIMITER ;\nSELECT 2";
    const parts = splitSqlScript(script, 'mysql');
    expect(parts.map((p) => p.text)).toEqual([
      '-- first\nUPDATE t SET a = 1',
      "SELECT 'x;y'\nFROM t",
      'CREATE PROCEDURE p() BEGIN SELECT 1; END',
      'SELECT 2',
    ]);
    for (const part of parts) expect(script.slice(part.from, part.to)).toBe(part.text);
  });

  it('skips empty statements', () => {
    expect(splitSqlScript(' ;; \n', 'mysql')).toEqual([]);
  });

  it('keeps PostgreSQL dollar-quoted bodies and quoted identifiers whole', () => {
    const script = 'CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RAISE NOTICE \'a;b\';\n  RETURN 1;\nEND $$;\nSELECT "semi;colon" FROM t;\nDO $body$ BEGIN PERFORM 1; END $body$';
    expect(splitSqlStatements(script, 'postgres')).toEqual([
      "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RAISE NOTICE 'a;b';\n  RETURN 1;\nEND $$",
      'SELECT "semi;colon" FROM t',
      'DO $body$ BEGIN PERFORM 1; END $body$',
    ]);
  });
});

describe('statement kinds', () => {
  it('reads the first keyword past comments', () => {
    expect(leadingKeyword('/* hi */ -- x\n  select 1')).toBe('SELECT');
    expect(leadingKeyword('# note\n(SELECT 1) UNION (SELECT 2)')).toBe('(');
    expect(leadingKeyword('')).toBe('');
  });

  it('tells reads from writes', () => {
    expect(changesData('SELECT * FROM t', 'mysql')).toBe(false);
    expect(changesData('show tables', 'mysql')).toBe(false);
    expect(changesData('WITH x AS (SELECT 1) SELECT * FROM x', 'mysql')).toBe(false);
    expect(changesData('WITH x AS (SELECT 1) DELETE FROM t', 'mysql')).toBe(true);
    expect(changesData('update t set a = 1', 'mysql')).toBe(true);
    expect(changesData('SET @a = 1', 'mysql')).toBe(true);
  });

  it('tells PostgreSQL reads from writes', () => {
    const writes = (sql: string) => changesData(sql, 'postgres');
    expect(writes('SELECT replace(name, \'a\', \'b\') FROM t')).toBe(false);
    expect(writes('WITH x AS (SELECT replace(a, b, c) FROM t) SELECT * FROM x')).toBe(false);
    expect(writes('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone')).toBe(true);
    expect(writes('INSERT INTO t (a) VALUES (1) RETURNING id')).toBe(true);
    expect(writes('SELECT * INTO backup FROM t')).toBe(true);
    expect(writes('CALL mark_shipped(1)')).toBe(true);
    expect(writes("DO $$ BEGIN RAISE NOTICE 'hi'; END $$")).toBe(true);
    expect(writes('COPY t FROM STDIN')).toBe(true);
    expect(writes('COPY (SELECT * FROM t) TO STDOUT WITH CSV')).toBe(false);
    expect(writes('EXPLAIN SELECT 1')).toBe(false);
    expect(writes('EXPLAIN ANALYZE SELECT 1')).toBe(false);
    expect(writes('EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t')).toBe(true);
    expect(writes('SHOW search_path')).toBe(false);
    expect(writes('FETCH 10 FROM c')).toBe(false);
    expect(writes('SET search_path TO shop')).toBe(true);
    expect(writes('REFRESH MATERIALIZED VIEW m')).toBe(true);
  });

  it('pages SELECT, WITH and parenthesised queries only', () => {
    expect(isPageableQuery('SELECT 1', 'mysql')).toBe(true);
    expect(isPageableQuery('(SELECT 1)', 'mysql')).toBe(true);
    expect(isPageableQuery('SHOW TABLES', 'mysql')).toBe(false);
    expect(isPageableQuery('SELECT 1', 'postgres')).toBe(true);
    // Paging runs the query again; a CTE that deletes would delete again.
    expect(isPageableQuery('WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone', 'postgres')).toBe(false);
    expect(isPageableQuery('INSERT INTO t VALUES (1) RETURNING *', 'postgres')).toBe(false);
  });

  it('knows which statements EXPLAIN can describe', () => {
    expect(isExplainable('-- top\nSELECT 1', 'mysql')).toBe(true);
    expect(isExplainable('update t set a = 1', 'mysql')).toBe(true);
    expect(isExplainable('DELETE FROM t', 'mysql')).toBe(true);
    expect(isExplainable('SHOW TABLES', 'mysql')).toBe(false);
    expect(isExplainable('CREATE TABLE t (a INT)', 'mysql')).toBe(false);
    expect(isExplainable('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'postgres')).toBe(true);
    expect(isExplainable('VALUES (1), (2)', 'postgres')).toBe(true);
    expect(isExplainable('CALL p()', 'postgres')).toBe(false);
  });
});
