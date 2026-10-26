import { describe, expect, it } from 'vitest';
import { highlightShell, insertStage, withoutId } from './shellSyntax';

const classed = (text: string) =>
  highlightShell(text)
    .filter((s) => s.className)
    .map((s) => `${s.className.split(' ')[0]}:${s.text}`);

describe('highlightShell', () => {
  it('tells keys, operators, constructors and values apart', () => {
    expect(classed('{ _id: ObjectId("65f1"), n: -1.5e3, ok: true, $match: null, r: /x/i } // note')).toEqual([
      'tok-propertyName:_id',
      'tok-variableName:ObjectId',
      'tok-string:"65f1"',
      'tok-propertyName:n',
      'tok-operator:-',
      'tok-number:1.5e3',
      'tok-propertyName:ok',
      'tok-bool:true',
      'tok-mongoOperator:$match',
      'tok-keyword:null',
      'tok-propertyName:r',
      'tok-string2:/x/i',
      'tok-comment:// note',
    ]);
  });

  it('keeps every character and runs plain text together', () => {
    const text = '{\n  a: [1, "two", ISODate("2026-01-01T00:00:00Z")],\n  b: { c: /x/ } §\n}';
    expect(highlightShell(text).map((s) => s.text).join('')).toBe(text);
    expect(highlightShell('{ a: 1 }')).toEqual([
      { text: '{ ', className: '' },
      { text: 'a', className: 'tok-propertyName tok-definition' },
      { text: ': ', className: '' },
      { text: '1', className: 'tok-number' },
      { text: ' }', className: '' },
    ]);
  });
});

describe('withoutId', () => {
  it('drops a first _id line', () => {
    expect(withoutId('{\n  _id: ObjectId("65f1"),\n  a: 1\n}')).toBe('{\n  a: 1\n}');
  });

  it('drops an _id that spans lines', () => {
    expect(withoutId('{\n  _id: {\n    a: 1,\n    b: [2, 3]\n  },\n  c: 4\n}')).toBe('{\n  c: 4\n}');
  });

  it('drops an _id that comes last, with the comma before it', () => {
    expect(withoutId('{\n  a: 1,\n  _id: 5\n}')).toBe('{\n  a: 1\n}');
    expect(withoutId('{ a: 1, _id: 5 }')).toBe('{ a: 1 }');
  });

  it('works on one line, with quoted keys, and leaves nested _id fields alone', () => {
    expect(withoutId('{ _id: 1, a: { _id: 2 } }')).toBe('{ a: { _id: 2 } }');
    expect(withoutId('{ "_id": 1, a: 2 }')).toBe('{ a: 2 }');
    expect(withoutId('{\n  a: { _id: 2 }\n}')).toBe('{\n  a: { _id: 2 }\n}');
    expect(withoutId('[{ _id: 1 }]')).toBe('[{ _id: 1 }]');
  });
});

describe('insertStage', () => {
  it('adds a stage after the last one', () => {
    expect(insertStage('[\n  { $match: {} },\n  { $limit: 20 }\n]', '{ $count: "count" }')).toBe('[\n  { $match: {} },\n  { $limit: 20 },\n  { $count: "count" }\n]');
  });

  it('fills an empty pipeline', () => {
    expect(insertStage('[]', '{ $match: {} }')).toBe('[\n  { $match: {} }\n]');
    expect(insertStage('', '{ $match: {} }')).toBe('[\n  { $match: {} }\n]');
    expect(insertStage('[\n  { $match: {} },\n]', '{ $limit: 5 }')).toBe('[\n  { $match: {} },\n  { $limit: 5 }\n]');
  });

  it('leaves text without a closing bracket alone', () => {
    expect(insertStage('[{ $match: {} }', '{ $limit: 5 }')).toBe('[{ $match: {} }');
    expect(insertStage('{ $match: {} }', '{ $limit: 5 }')).toBe('{ $match: {} }');
  });
});
