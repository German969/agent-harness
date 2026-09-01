// Zod schema for scheduler/schedules.yml entries.
//
// Every entry is either activated to run (via YAML `enabled: true` OR a
// runtime override) AND satisfies its `requires_project_phase` gate. Both
// conditions must hold — see effective.ts.

import { z } from 'zod';

const AgentIdSchema = z.enum([
  'strategist',
  'platform',
  'builder-server',
  'builder-client',
  'guardian',
  'marketer',
  'harness',
]);

export const ReplyToSchema = z.object({
  provider: z.enum(['slack', 'linear', 'github']),
  channel: z.string().optional(),
  thread_ts: z.string().optional(),
  linear_team: z.string().optional(),
});

export const ScheduleEntrySchema = z.object({
  id: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().default('UTC'),
  agent: AgentIdSchema,
  skill: z.string().optional(),
  trigger: z.object({
    kind: z.literal('scheduled'),
    message: z.string().min(1),
    reply_to: ReplyToSchema.optional(),
  }),
  enabled: z.boolean().default(false),
  requires_project_phase: z.string().optional(),
});

export const SchedulesFileSchema = z.array(ScheduleEntrySchema);

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type ReplyTo = z.infer<typeof ReplyToSchema>;
