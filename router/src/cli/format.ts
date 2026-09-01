// Small formatting helpers for CLI output.
//
// Aim: readable, plain-text output. No ANSI colors (they don't survive piping
// through less / grep / redirects). One assumption: users read output in a
// terminal that's ≥ 100 columns wide.

/** Format a Unix ms timestamp as `YYYY-MM-DD HH:mm:ss UTC`. */
export function fmtTs(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** Format a USD amount with 4 significant digits. */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `$${n.toFixed(4)}`;
}

/**
 * Render an array of row objects as a plain text table. Column order comes
 * from the first row's keys. Widths are derived per-column (max header/data).
 */
export function table(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(no rows)';
  const keys = Object.keys(rows[0] ?? {});
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));

  const header = keys.map((k, i) => k.padEnd(widths[i] ?? 0)).join('  ');
  const rule = keys.map((_, i) => '-'.repeat(widths[i] ?? 0)).join('  ');
  const body = rows
    .map((r) => keys.map((k, i) => String(r[k] ?? '').padEnd(widths[i] ?? 0)).join('  '))
    .join('\n');

  return `${header}\n${rule}\n${body}`;
}

/**
 * Parse a duration expression like "1h", "30m", "7d" → milliseconds.
 * Throws on bad input.
 */
export function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m || !m[1] || !m[2]) {
    throw new Error(`invalid duration: ${s} (expected e.g. "1h", "30m", "7d")`);
  }
  const n = Number.parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case 's':
      return n * 1000;
    case 'm':
      return n * 60 * 1000;
    case 'h':
      return n * 60 * 60 * 1000;
    case 'd':
      return n * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration unit: ${unit}`);
  }
}

/** Parse `YYYY-MM` → `{ year, month }`. */
export function parseYearMonth(s: string): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(s.trim());
  if (!m || !m[1] || !m[2]) {
    throw new Error(`invalid month: ${s} (expected YYYY-MM)`);
  }
  const year = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  if (month < 1 || month > 12) {
    throw new Error(`month out of range: ${month}`);
  }
  return { year, month };
}
