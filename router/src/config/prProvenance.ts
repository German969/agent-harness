// Which persona opened a pull request.
//
// Every PR in this fleet is authored by one human GitHub account, because the work is
// done by Claude sessions running an agent persona rather than by the router's per-agent
// GitHub Apps. So the author field says nothing, and provenance has been an inference
// drawn by reading the diff — HAR-16 reconstructed twelve open PRs that way and could
// not resolve one of them.
//
// WHY A TRAILER AND NOT AN `agent:` LABEL. `classifier.ts` resolves a PR's router owner
// by stripping `OWNER_LABEL_PREFIX` ('agent:') off a label and looking the remainder up
// in the identity registry. So `agent:guardian` on a session PR would resolve as a
// router fan-out target the moment HAR-9 lands — the cascade the gate exists to prevent.
// A `Agent:` commit/body trailer shares no namespace with that lookup and needs no label
// to exist first (all six are missing from this repo — HAR-13). On durability, stated
// precisely because the overstated version was the argument for picking a trailer at
// all: a trailer in a COMMIT MESSAGE reaches `main` and `git log --grep` finds it. A
// trailer in the PR BODY may or may not, depending on the repo's squash settings and
// what the merger types — so the body is the review-time record and the commit message
// is the durable one. (Copilot, dev-team-state#29.)
//
// The persona is NOT the bot identity. `guardian` here means "a session wearing the
// Guardian persona", which is the human's account; `identities/guardian.yml` names a
// GitHub App that did not open this PR. Keeping the two spellings apart is deliberate.

/** Value meaning "a person wrote this directly, wearing no persona". */
export const HUMAN_PERSONA = 'human';

/** Matches a trailer line: `Agent: <persona>`, key case-insensitive, one bare token. */
const TRAILER = /^[ \t]*agent:[ \t]*([A-Za-z0-9_-]+)[ \t]*$/gim;

export type ProvenanceResult =
  | { kind: 'ok'; persona: string; source: string }
  | { kind: 'missing'; problem: string }
  | { kind: 'unknown'; persona: string; problem: string };

/**
 * Find the `Agent:` trailer across the candidate texts, in order. The first text that
 * carries one wins, so a PR body beats a commit message — the body is what a reviewer
 * reads, and it is the text an author can correct without a force-push. It is NOT the
 * durable copy; see the note on squash settings above.
 *
 * `personas` is the set of agent directory names; `HUMAN_PERSONA` is always accepted.
 */
export function resolveProvenance(
  texts: ReadonlyArray<{ source: string; text: string }>,
  personas: ReadonlySet<string>,
): ProvenanceResult {
  for (const { source, text } of texts) {
    TRAILER.lastIndex = 0;
    const found = [...text.matchAll(TRAILER)].map((m) => (m[1] ?? '').toLowerCase());
    if (found.length === 0) continue;
    // Last wins within one text: a trailer belongs at the end, and quoting an earlier
    // PR's trailer in the body should not outrank the one the author actually wrote.
    const persona = found[found.length - 1] as string;
    if (persona === HUMAN_PERSONA || personas.has(persona)) {
      return { kind: 'ok', persona, source };
    }
    return {
      kind: 'unknown',
      persona,
      problem: `${source} names persona '${persona}', which is not an agent in agents/ (and is not '${HUMAN_PERSONA}'). Known: ${[...personas].sort().join(', ')}`,
    };
  }
  return {
    kind: 'missing',
    problem: `no \`Agent: <persona>\` trailer found in ${texts.map((t) => t.source).join(' or ')}. Add a line \`Agent: <name>\` naming the persona that did the work, or \`Agent: ${HUMAN_PERSONA}\` if a person wrote it directly. This is how provenance survives the session — see HAR-16.`,
  };
}

/** Everything the CLI does except exiting, so it is reachable from a test. The script
 *  entrypoint under `scripts/` is outside `tsconfig`'s `include` and outside
 *  `biome check src tests`, so logic left there is checked by nothing — raised by
 *  Copilot on #62. Only the three-line exit shim remains out there now. */
export function checkProvenance(
  env: {
    PR_BODY?: string | undefined;
    PR_COMMITS_FILE?: string | undefined;
    PR_COMMITS?: string | undefined;
  },
  deps: { personas: ReadonlySet<string>; readFile: (p: string) => string },
): { code: 0 | 1; out: string } {
  let commits = '';
  const file = env.PR_COMMITS_FILE;
  if (file) {
    try {
      commits = deps.readFile(file);
    } catch (err) {
      // Report and fall through to a FAILING check. Treating an unreadable file as
      // empty input would pass any PR whose trailer lives only in its commits.
      return {
        code: 1,
        out: `PR provenance check failed:\n  - could not read PR_COMMITS_FILE '${file}': ${(err as Error).message}`,
      };
    }
  } else {
    commits = env.PR_COMMITS ?? '';
  }

  const result = resolveProvenance(
    [
      { source: 'the PR body', text: env.PR_BODY ?? '' },
      { source: 'a branch commit message', text: commits },
    ],
    deps.personas,
  );

  if (result.kind === 'ok') {
    return { code: 0, out: `provenance ok — ${result.source} says \`Agent: ${result.persona}\`` };
  }
  return {
    code: 1,
    out: `PR provenance check failed:\n  - ${result.problem}\n\nA PR must record the persona that did the work. Put a trailer on its own line in a\nCOMMIT MESSAGE — the placement that reaches main and stays greppable — and/or in the PR\nbody, which is read first and is easier to correct without a force-push:\n\n    Agent: <name>\n\nValid: ${[...deps.personas].sort().join(', ')}, ${HUMAN_PERSONA}`,
  };
}
