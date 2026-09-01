// Public surface of the consumer bridge.

export { buildConsumer, handleEvent } from './consumer.js';
export type { ConsumerDeps, ConsumerOutcome } from './consumer.js';
export { extractInitialMessage } from './extractMessage.js';
export { resolveReplyTarget } from './replyTarget.js';
