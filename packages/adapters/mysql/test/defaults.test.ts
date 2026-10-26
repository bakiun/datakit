import { describe, expect, it } from 'vitest';
import { defaultSql } from '../src/defaults';

const text = { nullable: true, numeric: false, extra: '' };
const number = { nullable: false, numeric: true, extra: '' };

describe('defaultSql', () => {
  it('reads MySQL defaults', () => {
    expect(defaultSql("it's", text, 'MySQL')).toBe("'it''s'");
    expect(defaultSql('0.00', number, 'MySQL')).toBe('0.00');
    expect(defaultSql(null, text, 'MySQL')).toBe('NULL');
    expect(defaultSql(null, number, 'MySQL')).toBeNull();
    expect(defaultSql('CURRENT_TIMESTAMP', { ...text, extra: 'DEFAULT_GENERATED' }, 'MySQL')).toBe('CURRENT_TIMESTAMP');
    expect(defaultSql('uuid()', { ...text, extra: 'DEFAULT_GENERATED' }, 'MySQL')).toBe('(uuid())');
    expect(defaultSql("b'1'", number, 'MySQL')).toBe("b'1'");
  });

  it('reads MariaDB defaults', () => {
    expect(defaultSql("'TRY'", text, 'MariaDB')).toBe("'TRY'");
    expect(defaultSql('NULL', text, 'MariaDB')).toBe('NULL');
    expect(defaultSql('0.00', number, 'MariaDB')).toBe('0.00');
    expect(defaultSql('current_timestamp()', text, 'MariaDB')).toBe('current_timestamp()');
    expect(defaultSql('uuid()', text, 'MariaDB')).toBe('(uuid())');
  });
});
