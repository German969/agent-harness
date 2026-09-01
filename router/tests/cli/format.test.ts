import { describe, expect, it } from 'vitest';
import { fmtTs, fmtUsd, parseDuration, parseYearMonth, table } from '../../src/cli/format.js';

describe('fmtTs', () => {
  it('formats a UTC timestamp', () => {
    // 2026-06-15 14:30:00 UTC
    const ts = Date.UTC(2026, 5, 15, 14, 30, 0);
    expect(fmtTs(ts)).toBe('2026-06-15 14:30:00 UTC');
  });

  it('renders null/undefined as em dash', () => {
    expect(fmtTs(null)).toBe('—');
    expect(fmtTs(undefined)).toBe('—');
  });
});

describe('fmtUsd', () => {
  it('formats to 4 decimal places', () => {
    expect(fmtUsd(1.234567)).toBe('$1.2346');
  });
  it('null → em dash', () => {
    expect(fmtUsd(null)).toBe('—');
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30 * 1000],
    ['5m', 5 * 60 * 1000],
    ['2h', 2 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
  ])('parses %s', (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it('rejects bad input', () => {
    expect(() => parseDuration('7')).toThrow();
    expect(() => parseDuration('7x')).toThrow();
    expect(() => parseDuration('')).toThrow();
  });
});

describe('parseYearMonth', () => {
  it('parses YYYY-MM', () => {
    expect(parseYearMonth('2026-06')).toEqual({ year: 2026, month: 6 });
  });
  it('rejects bad format', () => {
    expect(() => parseYearMonth('2026-6')).toThrow();
    expect(() => parseYearMonth('2026-13')).toThrow();
    expect(() => parseYearMonth('not-a-date')).toThrow();
  });
});

describe('table', () => {
  it('empty input → "(no rows)"', () => {
    expect(table([])).toBe('(no rows)');
  });

  it('renders header + rule + rows aligned', () => {
    const out = table([
      { id: 1, name: 'aaa' },
      { id: 22, name: 'bb' },
    ]);
    const lines = out.split('\n');
    expect(lines).toHaveLength(4); // header, rule, 2 rows
    // Widths: id = max(2, 1, 2) = 2 (header) but "22" is 2 too, so 2. name = max(4, 3, 2) = 4.
    expect(lines[0]).toMatch(/^id\s+name\s*$/);
  });
});
