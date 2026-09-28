// Validate:fleet check 10 (HAR-22): every skill file is one the router can select,
// or is listed in NOT_ROUTER_SELECTED with a reason.
//
// Check 5 runs the other way: every skill the router can select has a file. Nothing
// checked this direction, so a skill whose only trigger was a Linear label the
// router never mapped sat unreachable while its docs promised the label worked.
// Pure, so the tests can use fakes.

export function skillReachProblems(
  agent: string,
  skillFiles: readonly string[],
  resolvable: readonly string[],
  notRouterSelected: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const canSelect = new Set(resolvable);
  const files = new Set(skillFiles);
  for (const skill of skillFiles) {
    // hasOwn, not `in`: a file named constructor.md must not read as listed.
    if (!canSelect.has(skill) && !Object.hasOwn(notRouterSelected, skill)) {
      problems.push(
        `${agent}: agents/${agent}/skills/${skill}.md is a skill the router can never select — no selector, LABEL_SKILLS entry, intent or default reaches it. Map a trigger to it in routing/skill.ts, or list it in NOT_ROUTER_SELECTED with the reason`,
      );
    }
  }
  for (const [skill, reason] of Object.entries(notRouterSelected)) {
    if (!files.has(skill)) {
      problems.push(
        `${agent}: NOT_ROUTER_SELECTED lists '${skill}', which has no file under agents/${agent}/skills/`,
      );
    } else if (canSelect.has(skill)) {
      problems.push(
        `${agent}: NOT_ROUTER_SELECTED lists '${skill}', but the router can select it; remove the entry`,
      );
    }
    if (reason.trim() === '') {
      problems.push(`${agent}: NOT_ROUTER_SELECTED lists '${skill}' with no reason`);
    }
  }
  return problems;
}
