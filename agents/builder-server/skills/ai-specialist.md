---
name: ai-specialist
description: LLM features — prompts, RAG, evals, model selection. Every prompt change ships with an eval that demonstrates the improvement. Every new LLM call ships with a cost projection. Discipline: no "this prompt looks better to me" merges. Operates inside the standard development cycle (CLAUDE.md), with prompt-engineering-specific additions in Phase 2 (plan) and Phase 4 (test).
---

# Skill — AI Specialist

## Activate when

- Linear ticket with label `ai`
- Paths in the diff matching the AI service directory (e.g. `server/services/ai/`, `apps/ai/`, etc. — defined in stack)
- Files matching `*prompts*`, `*evals*`, `*rag*`, `langchain.config*`

## Specialized knowledge

- **LLM API integration patterns**: streaming, retries with backoff, token accounting, structured output (JSON mode / tool use).
- **Prompt design discipline**: every prompt change ships with an eval that demonstrates the improvement. No "looks better to me" merges.
- **Eval frameworks**: how to run a current eval, how to add a new eval case, how to interpret pass/fail.
- **RAG**: chunking strategies, embedding choices, retrieval evaluation (precision/recall), index update patterns.
- **Vector DB**: connection patterns, schema, similarity-search tuning.
- **Model routing**: when to use Haiku/Sonnet/Opus on the product side (separate from your own model choice).
- **Cost discipline**: every new LLM call needs an estimated $/call + a monthly projected cost in the PR description. PRs that don't include this get auto-rejected by self-review.
- **Prompt caching**: how to structure prompts to maximize cache hits.
- **The Guardian llm-security counterpart**: Guardian's `llm-security` skill writes *adversarial* evals (does the LLM refuse the wrong thing?). Your evals are *functional* (does the LLM do the right thing?). Both run on AI PRs; neither replaces the other. Coordinate when designing new prompts — Guardian will adversarially probe them.

## Procedure

Follows the standard development cycle (CLAUDE.md §"The development cycle"). Additions specific to this skill:

### Phase 2 (Plan) additions

Include a **"Cost projection"** section in the plan:
```
### Cost projection
- Tokens per call: ~<N> input + ~<M> output
- Calls per day (estimated): <N>
- Monthly cost: $<N> at <model> pricing (current rates from <source>)
- Compared to existing AI spend: +<X>%
```

### Phase 3 (Implement) additions

- **When changing a prompt**, write the new eval case **before** changing the prompt. Run the eval against the current prompt to baseline.
- For new evals, prefer adding to the project's existing eval suite over a one-off script.

### Phase 4 (Self-test) additions

- **Run the eval suite.** The new/changed eval must pass. The existing evals must not regress more than the project's tolerance (default: 0 regressions).
- For RAG changes, evaluate retrieval quality (precision/recall on a known set) before evaluating end-to-end output.

### Phase 5 (Self-review) additions

- [ ] Cost projection included in PR description
- [ ] Eval delta (before/after numbers) included in PR description
- [ ] Prompt diff highlighted in the PR description (not just buried in the file diff)
- [ ] No prompt change without a corresponding eval that exercises the improvement
- [ ] No new model call without `prompt-cache` markers where the static portion of the prompt would benefit

### Phase 6 (Open PR) additions

PR description **must** include:
- Cost projection
- Eval delta (before / after pass counts; what changed)
- Prompt diff highlighted

## Outputs

- PRs touching AI service code, prompt files, eval cases
- Updated `dev-team-state/projects/<project>/builder-server/ai/prompt-experiments.md` log entries
- Cost-projection commentary inline in PR descriptions

## Examples

> **Input** (Linear): "Improve the project-summary prompt — current output is too generic"
>
> **Plan**:
> - Add a new eval case (5 example projects with expected summary characteristics)
> - Baseline current prompt: 3/5 pass
> - Revise prompt to include domain-specific anchors
> - Target: 5/5 pass
> - Cost projection: no change (same prompt size; cache hit rate similar)
>
> **PR**: 3 commits (new eval cases, prompt revision, doc update). Description shows before/after eval results: "baseline 3/5 → after 5/5, no regressions on existing 28 evals."

## Escalation

- Eval regression on a different prompt while fixing this one → re-plan, possibly back out the change.
- Cost projection >$50/mo additional → tag `@platform-agent` (FinOps skill) **before** opening PR for sign-off.
- Vendor change (e.g. switching from OpenAI to Anthropic) → ping `@platform-agent` (architect) for an ADR.
- Eval suite missing for the area you're touching → flag in the plan; ask if establishing baseline evals is in scope before changing prompts.

## What this skill does NOT do

- Run adversarial security evals — that's `@guardian-agent` (llm-security skill). Coordinate.
- Build the eval framework itself — use what exists.
- Decide product-level AI strategy (which features should use AI, which shouldn't) — that's Strategist + humans.
- Ship a prompt change without an eval proving the improvement.
