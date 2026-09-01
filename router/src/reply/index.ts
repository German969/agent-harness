// Public surface of the reply layer.

export { ReplyBatcher, type BatcherOptions } from './batcher.js';
export { renderFooter } from './footer.js';
export { GitHubReplyClient, type GitHubClientOptions } from './github.js';
export { LinearReplyClient, type LinearClientOptions } from './linear.js';
export { SlackReplyClient, type SlackClientOptions } from './slack.js';
export { buildReplyClient, ReplyStreamer, type StreamerOptions } from './streamer.js';
export type { FetchLike, ReplyClient, ReplyTarget, SessionFooter, StreamChunk } from './types.js';
