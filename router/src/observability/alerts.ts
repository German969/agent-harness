// AlertPoster — the narrow interface Phase 8 (cost cap) + Phase 10 (alert rules)
// use to send messages to `#agents-alerts` (or wherever `alertChannel` points).
//
// The real Slack implementation lands in Phase 10 (or Phase 7 if the reply
// streamer surfaces first). Phase 8 needs only the contract + a memory-buffered
// stub for tests and a no-op fallback for early dev.

export type AlertLevel = 'warn' | 'error' | 'info';

export type AlertMessage = {
  agent: string;
  channel: string; // e.g. `#agents-alerts`
  level: AlertLevel;
  title: string;
  body: string;
  /** Extra structured context — dumped as key: value bullets in the rendered message. */
  fields?: Record<string, string | number> | undefined;
};

export interface AlertPoster {
  post(msg: AlertMessage): Promise<void>;
  readonly kind: 'noop' | 'memory' | 'slack';
}

/**
 * A no-op AlertPoster. Used in production before Slack is wired, and in tests
 * that don't want to inspect posted messages.
 */
export class NoopAlertPoster implements AlertPoster {
  readonly kind = 'noop' as const;
  async post(): Promise<void> {
    /* discard */
  }
}

/**
 * A memory-buffered AlertPoster. Tests read `msg` to assert what was sent.
 */
export class MemoryAlertPoster implements AlertPoster {
  readonly kind = 'memory' as const;
  readonly messages: AlertMessage[] = [];
  async post(msg: AlertMessage): Promise<void> {
    this.messages.push(msg);
  }
  clear(): void {
    this.messages.length = 0;
  }
}
