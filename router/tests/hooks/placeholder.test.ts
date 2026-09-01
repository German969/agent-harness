import { describe, expect, it } from 'vitest';
import { contextVars, resolvePath, resolveVars } from '../../src/hooks/index.js';
import { mkCtx } from './_rig.js';

describe('resolveVars', () => {
  it('substitutes known variables', () => {
    expect(resolveVars('hello ${NAME}!', { NAME: 'world' })).toBe('hello world!');
  });

  it('leaves unknown variables literal', () => {
    expect(resolveVars('${KNOWN}/${UNKNOWN}', { KNOWN: 'a' })).toBe('a/${UNKNOWN}');
  });

  it('supports multiple substitutions', () => {
    const out = resolveVars('${A}-${B}-${A}', { A: 'x', B: 'y' });
    expect(out).toBe('x-y-x');
  });

  it('preserves non-${} text unchanged', () => {
    expect(resolveVars('literal $NAME text', { NAME: 'x' })).toBe('literal $NAME text');
  });
});

describe('contextVars', () => {
  it('exports PROJECT / SESSION_ID / AGENT / TARGET_AGENT', () => {
    const ctx = mkCtx({ agent: 'guardian', sessionId: 99, projectName: 'proj' });
    const vars = contextVars(ctx);
    expect(vars.PROJECT).toBe('proj');
    expect(vars.SESSION_ID).toBe('99');
    expect(vars.AGENT).toBe('guardian');
    expect(vars.TARGET_AGENT).toBe('guardian');
  });

  it('includes SKILL when set', () => {
    const ctx = mkCtx({ skill: 'llm-security' });
    expect(contextVars(ctx).SKILL).toBe('llm-security');
  });
});

describe('resolvePath', () => {
  const ctx = mkCtx({
    devTeamRoot: '/root/dev-team',
    targetProjectRoot: '/root/mysaas',
    sessionId: 7,
  });

  it('rewrites <target-project>/ prefix', () => {
    expect(resolvePath('<target-project>/founding/PRODUCT.md', ctx)).toBe(
      '/root/mysaas/founding/PRODUCT.md',
    );
  });

  it('rewrites <target-project>-marketing/ prefix', () => {
    expect(resolvePath('<target-project>-marketing/blog/x.md', ctx)).toBe(
      '/root/mysaas-marketing/blog/x.md',
    );
  });

  it('rewrites dev-team/ prefix', () => {
    expect(resolvePath('dev-team/agents/strategist/CLAUDE.md', ctx)).toBe(
      '/root/dev-team/agents/strategist/CLAUDE.md',
    );
  });

  it('rewrites dev-team-state/ prefix to sibling of dev-team', () => {
    // For root '/root/dev-team', sibling is '/root/dev-team-state'.
    expect(resolvePath('dev-team-state/global/harness/log.md', ctx)).toBe(
      '/root/dev-team-state/global/harness/log.md',
    );
  });

  it('leaves absolute non-prefix paths unchanged', () => {
    expect(resolvePath('/etc/hosts', ctx)).toBe('/etc/hosts');
  });

  it('interpolates ${VAR} inside prefixed paths', () => {
    expect(resolvePath('dev-team-state/projects/${PROJECT}/harness/log.md', ctx)).toBe(
      '/root/dev-team-state/projects/testproj/harness/log.md',
    );
  });
});
