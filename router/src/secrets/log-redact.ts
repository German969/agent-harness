// pino redact configuration for the router's logger.
//
// The primary defense against secret leaks is: never log secret VALUES anywhere.
// The resolver + runtime log KEYS + COUNTS ("resolved 5 secrets for agent strategist"),
// never the values themselves.
//
// This redact list is the SECOND line of defense — if some future code
// accidentally logs an env-var block or a `secrets` object, pino scrubs
// well-known secret-shaped fields before they hit stdout.

/**
 * Field paths pino will scrub. Uses pino's redact-path syntax:
 *   - dot-separated for nesting
 *   - `*` matches one path segment
 *   - `[*]` matches array indices
 */
export const redactPaths = [
  // Semantic role names (uppercased) — what MCP configs reference.
  '*.GITHUB_APP_PRIVATE_KEY',
  '*.GITHUB_APP_WEBHOOK_SECRET',
  '*.GITHUB_APP_INSTALLATION_TOKEN',
  '*.LINEAR_TOKEN',
  '*.LINEAR_WEBHOOK_SECRET',
  '*.SLACK_BOT_TOKEN',
  '*.SLACK_SIGNING_SECRET',
  '*.ANTHROPIC_API_KEY',
  '*.CMS_API_KEY',
  '*.EMAIL_PLATFORM_API_KEY',
  '*.SOCIAL_SCHEDULER_API_KEY',
  '*.ANALYTICS_API_KEY',

  // Common env-var block containers.
  '*.env',
  '*.env.*',
  'env',
  'env.*',
  'sessionEnv',
  'sessionEnv.*',
  'secrets',
  'secrets.*',

  // Generic patterns often mistaken as safe to log.
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.privateKey',
  '*.private_key',
];

export const redactCensor = '[REDACTED]';

/** pino redact config object shape. */
export const pinoRedact = {
  paths: redactPaths,
  censor: redactCensor,
} as const;
