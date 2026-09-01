#!/usr/bin/env node
// `dev-team-logs` — the router's ops + debug CLI.
//
// Dispatches to per-command handlers. Every handler is a pure function taking
// (db, args) → Promise<string> so they're trivial to unit-test.

import { config } from '../config.js';
import { openDb } from '../state/db.js';
import { applyMigrations } from '../state/migrations/index.js';
import { parseArgv } from './argv.js';
import { agentCmd } from './commands/agent.js';
import { costCmd } from './commands/cost.js';
import { scheduleCmd } from './commands/schedule.js';
import { sessionCmd } from './commands/session.js';
import { triggerCmd } from './commands/trigger.js';

const USAGE = `dev-team-logs — router ops + debug CLI

usage: dev-team-logs <command> [args]

Sessions / debugging:
  session <id>                 full trace for a session
  agent <name> [--since 1h]    sessions for an agent in a time window
  trigger <thread-key>         all sessions in a thread
  cost --month YYYY-MM         cost breakdown for a month

Schedule control:
  schedule list [--agent X] [--disabled]  effective state of every entry
  schedule enable <id> [--reason "..."]   set override enabled
  schedule disable <id> [--reason "..."]  set override disabled
  schedule reset <id> [--reason "..."]    clear override
  schedule run <id>                       fire now
  schedule history <id>                   audit trail

Environment:
  STATE_DB_PATH          SQLite path (default from router config)
  SCHEDULES_PATH         schedules.yml path (default dev-team/scheduler/schedules.yml)
  TARGET_PROJECT_ROOT    project root for phase-gate reads (optional)
  CLI_ACTOR              recorded as \`set_by\` on override writes (default: shell user)
`;

export async function main(argv: string[]): Promise<{ code: number; out: string }> {
  const args = parseArgv(argv);
  const command = args.positional.shift();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    return { code: 0, out: USAGE };
  }

  const db = openDb({ path: config.STATE_DB_PATH });
  applyMigrations(db);

  const schedulesPath =
    process.env.SCHEDULES_PATH ?? `${config.DEV_TEAM_ROOT ?? '.'}/scheduler/schedules.yml`;
  const targetProjectRoot = process.env.TARGET_PROJECT_ROOT;
  const actor = process.env.CLI_ACTOR ?? process.env.USER ?? 'cli';

  try {
    switch (command) {
      case 'session':
        return { code: 0, out: sessionCmd(db, args) };
      case 'agent':
        return { code: 0, out: agentCmd(db, args) };
      case 'trigger':
        return { code: 0, out: triggerCmd(db, args) };
      case 'cost':
        return { code: 0, out: costCmd(db, args) };
      case 'schedule': {
        const out = await scheduleCmd(args, {
          db,
          schedulesPath,
          ...(targetProjectRoot ? { targetProjectRoot } : {}),
          actor,
        });
        return { code: 0, out };
      }
      default:
        return { code: 1, out: `unknown command: ${command}\n\n${USAGE}` };
    }
  } finally {
    db.close();
  }
}

// Direct-invocation entry (via `tsx src/cli/main.ts …` or the compiled `dist/cli/main.js`).
if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  main(process.argv.slice(2)).then(
    ({ code, out }) => {
      process.stdout.write(out);
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      process.exit(2);
    },
  );
}
