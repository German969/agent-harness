// Router entry point.
// Boots the Fastify server + wires shutdown signals.

import { config } from './config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const server = await buildServer();

  // Prevent unhandled stream / socket errors from taking down the whole router.
  // The Anthropic SDK's HTTP client, MCP child stdio pipes, and Slack HTTP
  // sends can all emit 'error' events (EPIPE, ECONNRESET, ETIMEDOUT) that
  // would otherwise propagate as uncaught exceptions — killing the process
  // and (with restart:unless-stopped) triggering a crash-loop that burns
  // through webhook backlogs. Log + swallow.
  process.on('uncaughtException', (err, origin) => {
    server.log.error(
      { err: err.message, stack: err.stack, origin },
      'uncaught exception (swallowed to keep router alive)',
    );
  });
  process.on('unhandledRejection', (reason, promise) => {
    server.log.error(
      { reason: String(reason), promise: String(promise) },
      'unhandled rejection (swallowed to keep router alive)',
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    server.log.info({ signal }, 'shutdown initiated');
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      server.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await server.listen({ port: config.PORT, host: config.HOST });
    server.log.info(
      { port: config.PORT, host: config.HOST, env: config.NODE_ENV },
      'router started',
    );
  } catch (err) {
    server.log.error({ err }, 'router failed to start');
    process.exit(1);
  }
}

void main();
