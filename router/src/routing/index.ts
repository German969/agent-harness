// Public surface of the routing module.

export { loadIdentities, type LoadResult } from './loader.js';
export {
  buildRegistry,
  findAgentByHint,
  type Registry,
} from './registry.js';
export {
  IdentityFileSchema,
  isKnownAgent,
  type Identity,
  type IdentityFile,
} from './schema.js';
export { buildThreadKey } from './threadKey.js';
export { extractMentionedAgent } from './mention.js';
export { resolveSkill } from './skill.js';
export {
  classify,
  isWorkTrigger,
  type Classification,
  type ClassifyDeps,
  type ContinuationDecision,
  type MatchReason,
} from './classifier.js';
export { buildSecretLookup } from './secret-lookup.js';
export { checkCrosspostsDrift } from './crossposts.js';
export { isAgentAuthoredEvent, agentFromBotLogin } from './authorship.js';
