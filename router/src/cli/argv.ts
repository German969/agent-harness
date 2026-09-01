// Minimal argv parser — good enough for the router's CLI surface.
//
// Deliberately dependency-free. Supports:
//   - positional args
//   - `--flag value`, `--flag=value`, `--flag` (bool)
//   - long form only (no `-f`); every flag is documented
//
// Not GNU-compatible; doesn't handle `--` terminator; doesn't do subcommand
// nesting beyond the two-level shape used by our CLI.

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgv(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        const key = arg.slice(2, eq);
        flags[key] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      // If next is a non-flag value, consume it as the flag's value.
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }

    positional.push(arg);
  }

  return { positional, flags };
}

/** Get a string flag or a fallback. Errors if the flag is present-as-boolean. */
export function getStringFlag(
  args: ParsedArgs,
  name: string,
  fallback?: string,
): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') {
    throw new Error(`--${name} requires a value`);
  }
  return v;
}

/** True if the flag is present at all (boolean or with a value). */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}
