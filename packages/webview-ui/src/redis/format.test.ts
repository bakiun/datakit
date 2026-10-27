import { describe, expect, it } from 'vitest';
import { parseTtl } from './format';

describe('parseTtl', () => {
  it('reads seconds and units', () => {
    expect(parseTtl('90')).toBe(90);
    expect(parseTtl('90s')).toBe(90);
    expect(parseTtl('30m')).toBe(1800);
    expect(parseTtl('2h')).toBe(7200);
    expect(parseTtl('1d')).toBe(86400);
    expect(parseTtl('1h 30m')).toBe(5400);
    expect(parseTtl(' 2 hours ')).toBe(7200);
    expect(parseTtl('3,600')).toBe(3600);
  });

  it('is null when empty and NaN when it cannot be read', () => {
    expect(parseTtl('')).toBeNull();
    expect(parseTtl('  ')).toBeNull();
    expect(parseTtl('soon')).toBeNaN();
    expect(parseTtl('10x')).toBeNaN();
    expect(parseTtl('5ms')).toBeNaN();
  });
});
