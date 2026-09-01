import { describe, expect, it } from 'vitest';
import { getStringFlag, hasFlag, parseArgv } from '../../src/cli/argv.js';

describe('parseArgv', () => {
  it('splits positional args + flags', () => {
    const a = parseArgv(['session', '42', '--since', '1h']);
    expect(a.positional).toEqual(['session', '42']);
    expect(a.flags).toEqual({ since: '1h' });
  });

  it('supports --flag=value', () => {
    const a = parseArgv(['cost', '--month=2026-06']);
    expect(a.positional).toEqual(['cost']);
    expect(a.flags).toEqual({ month: '2026-06' });
  });

  it('a flag with no value becomes boolean true', () => {
    const a = parseArgv(['schedule', 'list', '--disabled']);
    expect(a.flags).toEqual({ disabled: true });
  });

  it('multiple flags coexist', () => {
    const a = parseArgv(['agent', 'guardian', '--since', '24h', '--status', 'failed']);
    expect(a.positional).toEqual(['agent', 'guardian']);
    expect(a.flags).toEqual({ since: '24h', status: 'failed' });
  });
});

describe('getStringFlag', () => {
  it('returns the string value', () => {
    const a = parseArgv(['x', '--month', '2026-06']);
    expect(getStringFlag(a, 'month')).toBe('2026-06');
  });

  it('returns fallback when missing', () => {
    const a = parseArgv(['x']);
    expect(getStringFlag(a, 'month', 'default')).toBe('default');
  });

  it('throws if present-as-boolean', () => {
    const a = parseArgv(['x', '--month', '--other', 'v']);
    expect(() => getStringFlag(a, 'month')).toThrow('--month requires a value');
  });
});

describe('hasFlag', () => {
  it('detects boolean presence', () => {
    const a = parseArgv(['x', '--force']);
    expect(hasFlag(a, 'force')).toBe(true);
    expect(hasFlag(a, 'other')).toBe(false);
  });

  it('detects value presence', () => {
    const a = parseArgv(['x', '--month', '2026-06']);
    expect(hasFlag(a, 'month')).toBe(true);
  });
});
