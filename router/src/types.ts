// Shared types used across router modules.
// More types land in this file (or split into domain-specific files) as later phases ship.

export type AgentId =
  | 'strategist'
  | 'platform'
  | 'builder-server'
  | 'builder-client'
  | 'guardian'
  | 'marketer'
  | 'harness';

export type SkillId = string;

export type Provider = 'github' | 'linear' | 'slack';

export type SessionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'gated'
  | 'interrupted_needs_resume';

export type TriggerKind = 'webhook:github' | 'webhook:linear' | 'webhook:slack' | 'scheduled';
