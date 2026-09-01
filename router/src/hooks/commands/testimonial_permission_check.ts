// PreToolUse hook — shape:
//   { tool: [...], if_content_matches_pattern: '...', validate: 'testimonial_permission_check',
//     validator_path: 'dev-team-state/projects/${PROJECT}/marketer/testimonials/approved.md' }
//
// Marketer's customer-quote permission gate — the one hook in the fleet whose
// violation is somebody else's problem, not ours: publishing a customer's words
// without permission. Its config carries a ★ and the rule
// `every_customer_quote_must_have_approved_yes_status`. It had no handler.
//
// How it decides, and why it is built to be quiet:
//
//   1. The content has to look testimonial-ish (`if_content_matches_pattern`).
//      That pattern is broad on purpose — it includes the bare word "quote" — so
//      it is a cheap pre-filter, never the decision.
//   2. Then it extracts QUOTED SPANS. Only a real quotation can be an unapproved
//      testimonial; prose that merely says the word "testimonial" cannot.
//   3. Each span long enough to be a sentence is looked up in approved.md. A span
//      is cleared when it appears under an entry marked `approved: yes`.
//
// Short spans are ignored (SHORT_SPAN_CHARS). A marketing draft is full of quoted
// product names and UI labels, and a gate that fires on `"Export"` would be turned
// off within a day — which is the real failure mode for a policy hook.
//
// Fails CLOSED on an unapproved span, because that is the direction the config
// asks for: "Pull the quote OR escalate to a human to collect permission. Never
// publish content with unapproved testimonials." A MISSING approved.md is treated
// as an empty library rather than an error, so the first quote written before the
// library exists is stopped rather than waved through.

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolvePath } from '../placeholder.js';
import type { HookResult, ToolCallContext, ToolCallHookHandler } from '../types.js';

/** A quoted span shorter than this is a label or a product name, not a testimonial. */
const SHORT_SPAN_CHARS = 25;

type TestimonialConfig = {
  tool?: string | string[];
  if_content_matches_pattern?: string;
  validator_path?: string;
  on_violation_message?: string;
  message?: string;
};

export const testimonialPermissionCheckHandler: ToolCallHookHandler = async (
  config,
  ctx,
): Promise<HookResult> => {
  const cfg = config as TestimonialConfig;
  if (!toolMatches(cfg.tool, ctx.tool)) return { kind: 'allow' };

  const content = extractContent(ctx.input);
  if (!content) return { kind: 'allow' };

  if (!contentLooksTestimonial(cfg.if_content_matches_pattern, content, ctx)) {
    return { kind: 'allow' };
  }

  const spans = quotedSpans(content).filter((s) => s.length >= SHORT_SPAN_CHARS);
  if (spans.length === 0) return { kind: 'allow' };

  const approved = approvedQuotes(cfg.validator_path, ctx);
  const unapproved = spans.filter((span) => !approved.some((a) => a.includes(normalize(span))));
  if (unapproved.length === 0) return { kind: 'allow' };

  ctx.log.info(
    { agent: ctx.agent, tool: ctx.tool, count: unapproved.length },
    'testimonial_permission_check: denied content carrying an unapproved customer quote',
  );
  return {
    kind: 'deny',
    message:
      cfg.on_violation_message ??
      cfg.message ??
      `🛑 Quote not found in the approved testimonial library: "${truncate(unapproved[0] ?? '')}"`,
  };
};

/**
 * The approved quote text, normalised. An entry counts only when its block carries
 * `approved: yes` — a library row with `approved: no` or `approved: pending` is
 * exactly the case this gate exists to catch, so it must not be readable as
 * permission.
 *
 * Blocks are separated by a markdown heading or a horizontal rule, matching how a
 * per-customer library reads. Unreadable or missing file → no approvals, which
 * denies rather than allows.
 */
export function approvedQuotes(rawPath: string | undefined, ctx: ToolCallContext): string[] {
  if (!rawPath) return [];
  const resolved = resolvePath(rawPath, ctx);
  const abs = isAbsolute(resolved) ? resolved : join(ctx.devTeamRoot, '..', resolved);
  let text: string;
  try {
    text = readFileSync(abs, 'utf-8');
  } catch {
    ctx.log.debug({ path: abs }, 'testimonial_permission_check: no approved-testimonial library');
    return [];
  }
  return text
    .split(/^\s*(?:#{1,6}\s|---\s*$)/m)
    .filter((block) => /^\s*approved:\s*yes\s*$/im.test(block))
    .map(normalize);
}

/** Quoted spans, across the quote characters marketing copy actually uses. */
export function quotedSpans(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/"([^"]+)"|“([^”]+)”|'{2}([^']+)'{2}/g)) {
    const span = m[1] ?? m[2] ?? m[3];
    if (span?.trim()) out.push(span.trim());
  }
  return out;
}

/** Collapse whitespace and case so a re-wrapped quote still matches its library entry. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentLooksTestimonial(
  pattern: string | undefined,
  content: string,
  ctx: ToolCallContext,
): boolean {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, 'i').test(content);
  } catch (err) {
    // An unusable pre-filter must not silently disable a permission gate.
    ctx.log.warn(
      { pattern, err: (err as Error).message },
      'testimonial_permission_check: invalid if_content_matches_pattern; checking all content',
    );
    return true;
  }
}

/** The text a tool is about to write, across Write/Edit and the draft MCP tools. */
function extractContent(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const parts = [rec.content, rec.new_string, rec.newString, rec.body, rec.text].filter(
    (v): v is string => typeof v === 'string',
  );
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function toolMatches(cfgTool: string | string[] | undefined, actual: string): boolean {
  if (cfgTool === undefined || cfgTool === '*') return true;
  const list = Array.isArray(cfgTool) ? cfgTool : [cfgTool];
  return list.includes(actual);
}
