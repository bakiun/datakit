import type { MongoDocument } from '@datakit/core';
import { describe, expect, it } from 'vitest';
import {
  columnType,
  documentsArray,
  errorField,
  firstLines,
  formatBytes,
  formatSeconds,
  lastPageIndex,
  pageRange,
  pageSizeChoices,
  parseSkip,
  percent,
  splitPath,
  startPageSize,
  writesStage,
} from './format';

const doc = (text: string): MongoDocument => ({ id: null, idText: null, text, truncated: false, fields: [], size: text.length });

describe('paging', () => {
  it('starts from the configured page size within the offered sizes', () => {
    expect(startPageSize(50)).toBe(50);
    expect(startPageSize(5)).toBe(20);
    expect(startPageSize(10_000)).toBe(500);
    expect(startPageSize(0)).toBe(20);
    expect(pageSizeChoices(200)).toEqual([20, 50, 100, 200, 500]);
    expect(pageSizeChoices(50)).toEqual([20, 50, 100, 500]);
  });

  it('describes the shown range', () => {
    expect(pageRange(0, 20, 1234)).toBe('1–20 of 1,234');
    expect(pageRange(20, 20, null)).toBe('21–40 of many');
    expect(pageRange(0, 0, 0)).toBe('0 of 0');
    expect(pageRange(0, 0, null)).toBe('No documents');
  });

  it('finds the last page, counting from the Skip of the query', () => {
    expect(lastPageIndex(1234, 0, 20)).toBe(61);
    expect(lastPageIndex(40, 0, 20)).toBe(1);
    expect(lastPageIndex(0, 0, 20)).toBe(0);
    expect(lastPageIndex(110, 10, 50)).toBe(1);
    expect(lastPageIndex(null, 0, 20)).toBeNull();
  });

  it('reads a Skip', () => {
    expect(parseSkip('')).toBe(0);
    expect(parseSkip(' 1,000 ')).toBe(1000);
    expect(parseSkip('-4')).toBeNull();
    expect(parseSkip('ten')).toBeNull();
  });
});

describe('errorField', () => {
  it('finds the field an error starts with or names', () => {
    expect(errorField('Filter: Unexpected token (1:9)')).toBe('filter');
    expect(errorField('Project: unknown operator')).toBe('projection');
    expect(errorField('sort must be an object')).toBe('sort');
    expect(errorField('Invalid collation: locale is required')).toBe('collation');
    expect(errorField('Unexpected token in the projection')).toBe('projection');
    expect(errorField('Connection closed')).toBeNull();
  });
});

describe('text helpers', () => {
  it('keeps the first lines and counts the rest', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toEqual({ text: 'a\nb', hidden: 2 });
    expect(firstLines('a\nb', 2)).toEqual({ text: 'a\nb', hidden: 0 });
    expect(firstLines('a', 5)).toEqual({ text: 'a', hidden: 0 });
  });

  it('writes a page as one indented array', () => {
    expect(documentsArray([])).toBe('[]');
    expect(documentsArray([doc('{\n  a: 1\n}'), doc('{\n  a: 2\n}')])).toBe('[\n  {\n    a: 1\n  },\n  {\n    a: 2\n  }\n]');
  });

  it('formats sizes and shares', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB');
    expect(percent(0, 10)).toBe('0%');
    expect(percent(1, 1000)).toBe('<1%');
    expect(percent(999, 1000)).toBe('>99%');
    expect(percent(10, 10)).toBe('100%');
    expect(percent(1, 3)).toBe('33%');
  });

  it('formats durations in the largest whole unit', () => {
    expect(formatSeconds(7_776_000)).toBe('90 d');
    expect(formatSeconds(7200)).toBe('2 h');
    expect(formatSeconds(1800)).toBe('30 min');
    expect(formatSeconds(90)).toBe('90 s');
    expect(formatSeconds(0)).toBe('0 s');
  });

  it('splits schema paths', () => {
    expect(splitPath('status')).toEqual({ parent: '', leaf: 'status', depth: 0 });
    expect(splitPath('items[].sku')).toEqual({ parent: 'items[].', leaf: 'sku', depth: 1 });
    expect(splitPath('a.b.c')).toEqual({ parent: 'a.b.', leaf: 'c', depth: 2 });
  });

  it('names the type of a column', () => {
    expect(columnType(['String', 'String', 'Null'])).toBe('String');
    expect(columnType(['String', 'Int32'])).toBe('mixed');
    expect(columnType(['Null'])).toBe('Null');
    expect(columnType([])).toBe('');
  });

  it('spots pipelines that write', () => {
    expect(writesStage('[{ $match: {} }, { $out: "copy" }]')).toBe(true);
    expect(writesStage('[{ $merge: { into: "x" } }]')).toBe(true);
    expect(writesStage('[{ $match: { outcome: 1 } }]')).toBe(false);
  });
});
