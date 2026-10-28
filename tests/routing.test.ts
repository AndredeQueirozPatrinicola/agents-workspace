import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addAccountToSettings, loadSettings, resolveAccounts, settingsSchema, validateSettings } from '../src/core/accounts/settings.js';
import { AccountMarks, detectUsageLimit, parseUntil } from '../src/core/accounts/state.js';
import { type RouterContext, nextAccount, nextEffort, routePlanner, routeTask } from '../src/core/routing/router.js';
import { checkPlan, globsOverlap, planSchema, planWaves, type Plan } from '../src/core/features/plan.js';
import { slugify } from '../src/core/features/store.js';
import { ClaudeProvider } from '../src/providers/claude/claude.js';
import { CodexProvider } from '../src/providers/codex/codex.js';
import { MockRunner, tempDir } from './helpers.js';

function ctx(yaml: object, policy: string[] | null = null, marks: RouterContext['marks'] = {}): RouterContext {
  const settings = settingsSchema.parse(yaml);
  return { settings, accounts: resolveAccounts(settings, ['codex', 'claude']), marks, policy, defaultProvider: 'codex' };
}

const accounts = {
  accounts: {
    'codex-personal': { provider: 'codex', home: '/h/cp', tags: ['personal'] },
    'codex-work': { provider: 'codex', home: '/h/cw', tags: ['work'] },
    'claude-work': { provider: 'claude', home: '/h/cl', tags: ['work'] },
  },
};

describe('router', () => {
  it('uses the default policy without settings: effort from complexity or risk, planner suggestion for provider', () => {
    const c = ctx({});
    expect(routeTask({ complexity: 'low', risk: 'low' }, c)).toMatchObject({ account: 'codex', provider: 'codex', effort: 'low' });
    expect(routeTask({ complexity: 'low', risk: 'high' }, c)).toMatchObject({ effort: 'high' });
    const d = routeTask({ complexity: 'medium', risk: 'low', suggestedProvider: 'claude', suggestedEffort: 'xhigh' }, c);
    expect(d).toMatchObject({ account: 'claude', provider: 'claude', effort: 'xhigh' });
    expect(d.reason).toMatch(/planner suggested claude/);
  });

  it('applies the first matching rule and explains it', () => {
    const c = ctx({
      ...accounts,
      routing: {
        rules: [
          { when: { risk: 'high' }, use: { account: 'claude-work', effort: 'high' } },
          { when: { complexity: 'low' }, use: { account: 'codex-personal', effort: 'low' } },
          { when: { complexity: ['medium', 'high'] }, use: { provider: 'codex', effort: 'high', model: 'gpt-x' } },
        ],
      },
    });
    expect(routeTask({ complexity: 'low', risk: 'high' }, c)).toMatchObject({ account: 'claude-work', effort: 'high' });
    expect(routeTask({ complexity: 'low', risk: 'low' }, c).reason).toBe('rule 2 (complexity low) → codex-personal, effort low');
    // A provider rule prefers a declared account over the implicit default login.
    expect(routeTask({ complexity: 'high', risk: 'low' }, c)).toMatchObject({ account: 'codex-personal', model: 'gpt-x' });
  });

  it('never chooses an account the project does not allow, and only warns about limited accounts', () => {
    const rules = { routing: { rules: [{ when: { complexity: 'low' }, use: { account: 'codex-personal' } }] } };
    const c = ctx({ ...accounts, ...rules }, ['work'], { 'codex-work': { status: 'limited', since: '', until: null, note: 'out of credits', source: 'user' } });
    const d = routeTask({ complexity: 'low', risk: 'low' }, c);
    expect(d.account).toBe('codex-work');
    expect(d.warnings.join('\n')).toMatch(/rule 1 skipped: account "codex-personal" is not allowed/);
    expect(d.warnings.join('\n')).toMatch(/codex-work is marked limited.*out of credits/);
    expect(nextAccount('codex-work', c)?.name).toBe('claude-work');
    expect(nextAccount('claude-work', c)?.name).toBe('codex-work');
    expect(() => routeTask({ complexity: 'low', risk: 'low' }, ctx(accounts, ['nothing']))).toThrow(/No account is allowed/);
  });

  it('routes the planner from settings, an override, or the default', () => {
    expect(routePlanner(ctx({}))).toMatchObject({ account: 'codex', effort: 'high' });
    expect(routePlanner(ctx({ ...accounts, routing: { planner: { account: 'claude-work', effort: 'max' } } }))).toMatchObject({ account: 'claude-work', effort: 'max' });
    expect(routePlanner(ctx(accounts), { provider: 'claude' })).toMatchObject({ account: 'claude-work' });
    expect(() => routePlanner(ctx(accounts, ['personal']), { account: 'claude-work' })).toThrow(/not allowed/);
    expect(nextEffort('max')).toBe('low');
    expect(nextEffort('low', -1)).toBe('max');
  });
});

describe('accounts', () => {
  it('loads, validates and extends settings.yaml without losing comments', async () => {
    const dir = tempDir();
    expect((await loadSettings(dir)).accounts).toEqual({});
    await addAccountToSettings(dir, 'codex-work', { provider: 'codex', home: '~/.codex-work', tags: ['work'] });
    await addAccountToSettings(dir, 'claude-work', { provider: 'claude', tags: [] });
    await expect(addAccountToSettings(dir, 'codex-work', { provider: 'codex', tags: [] })).rejects.toThrow(/already exists/);
    const s = await loadSettings(dir);
    expect(Object.keys(s.accounts)).toEqual(['codex-work', 'claude-work']);
    const resolved = resolveAccounts(s, ['codex', 'claude']);
    expect(resolved.find((a) => a.name === 'codex-work')?.home).toMatch(/\.codex-work$/);
    expect(resolved.map((a) => a.name)).toEqual(['codex-work', 'claude-work', 'codex', 'claude']);
    expect(validateSettings(settingsSchema.parse({ accounts: { x: { provider: 'nope' } }, routing: { rules: [{ use: { account: 'y' } }] } }), ['codex'])).toEqual([
      'accounts.x.provider: unknown provider "nope"',
      'routing.rules[0].use.account: unknown account "y"',
    ]);
    writeFileSync(path.join(dir, 'settings.yaml'), 'accounts: [1');
    await expect(loadSettings(dir)).rejects.toThrow(/Invalid YAML/);
  });

  it('keeps availability marks, lets user marks win over detections, and expires them', async () => {
    const marks = new AccountMarks(tempDir());
    await marks.markLimited('a', { note: 'mine', until: new Date(Date.now() + 60_000) });
    await marks.markLimited('a', { note: 'detected', source: 'detected' });
    await marks.markLimited('b', { until: new Date(Date.now() - 1000) });
    const loaded = await marks.load();
    expect(loaded.a?.note).toBe('mine');
    expect(loaded.b).toBeUndefined();
    await marks.clear('a');
    expect(await marks.load()).toEqual({});
    const now = new Date('2026-10-28T10:00:00');
    expect(parseUntil('2h', now)?.getTime()).toBe(now.getTime() + 7_200_000);
    expect(parseUntil('18:30', now)?.getHours()).toBe(18);
    expect(parseUntil('09:00', now)?.getDate()).toBe(29);
    expect(parseUntil('nonsense', now)).toBeNull();
    expect(detectUsageLimit('working…\n■ You\'ve hit your usage limit. Try again at 6:00 PM.\n> ')).toMatch(/usage limit/);
    expect(detectUsageLimit('all good\n> ')).toBeNull();
  });
});

describe('plans', () => {
  const task = (id: string, extra: Partial<Plan['tasks'][number]> = {}): Plan['tasks'][number] => ({
    id,
    title: id,
    objective: 'o',
    context: '',
    scope: [`src/${id}/**`],
    dependsOn: [],
    acceptance: ['a'],
    validation: ['npm test'],
    complexity: 'low',
    risk: 'low',
    rationale: '',
    suggestedProvider: 'any',
    suggestedEffort: 'low',
    ...extra,
  });
  const plan = (tasks: Plan['tasks']): Plan => ({ title: 't', summary: 's', approach: '', questions: [], tasks });

  it('validates dependencies, cycles and parallel scope overlaps, and computes waves', () => {
    expect(checkPlan(plan([task('a'), task('b', { dependsOn: ['zzz'] })])).errors).toEqual(['task "b" depends on unknown task "zzz"']);
    expect(checkPlan(plan([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])).errors.join()).toMatch(/cycle/);
    const overlap = checkPlan(plan([task('a', { scope: ['src/**'] }), task('b', { scope: ['src/api/x.ts'] })]));
    expect(overlap.warnings.join()).toMatch(/run in parallel and both touch src\/\*\*/);
    // Sequential tasks may share files.
    expect(checkPlan(plan([task('a', { scope: ['src/**'] }), task('b', { scope: ['src/x.ts'], dependsOn: ['a'] })])).warnings).toEqual([]);
    expect(checkPlan(plan([task('a', { validation: [], scope: [] })])).warnings).toHaveLength(2);
    expect(planWaves(plan([task('a'), task('b'), task('c', { dependsOn: ['a', 'b'] }), task('d', { dependsOn: ['c'] })]))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(globsOverlap('src/a/**', 'src/b/**')).toBe(false);
    expect(globsOverlap('package.json', 'package.json')).toBe(true);
    expect(planSchema.safeParse(plan([task('Bad Id')])).success).toBe(false);
  });

  it('derives readable feature ids', () => {
    expect(slugify('Adicionar autenticação JWT ao painel')).toBe('adicionar-aute');
    expect(slugify('123 go')).toBe('f-123-go');
    expect(slugify('!!!')).toBe('feature');
  });
});

describe('providers: effort, accounts and structured exec', () => {
  const runner = new MockRunner();
  const base = { agentName: 'a', projectName: 'p', worktreePath: '/wt', branch: 'b', promptFile: '/p', model: undefined, providerArgs: [], agentArgs: [], resume: false, addDirs: [], command: undefined };

  it('passes effort and the account directory to interactive launches', () => {
    const codex = new CodexProvider(runner).buildLaunchCommand({ ...base, effort: 'max', accountHome: '/h/cw' });
    expect(codex.args).toContain('model_reasoning_effort="xhigh"');
    expect(codex.env.CODEX_HOME).toBe('/h/cw');
    const claude = new ClaudeProvider(runner).buildLaunchCommand({ ...base, effort: 'high', accountHome: '/h/cl' });
    expect(claude.args.slice(0, 2)).toEqual(['--effort', 'high']);
    expect(claude.env.CLAUDE_CONFIG_DIR).toBe('/h/cl');
    expect(new ClaudeProvider(runner).buildLaunchCommand(base).env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('builds read-only, schema-constrained one-shot commands and parses their answers', () => {
    const exec = { cwd: '/repo', prompt: 'plan it', schema: { type: 'object' }, workDir: '/w', model: 'm', effort: 'high' as const, accountHome: '/h' };
    const c = new CodexProvider(runner).buildExecCommand(exec);
    expect(c.args).toEqual(['exec', '--sandbox', 'read-only', '--cd', '/repo', '--skip-git-repo-check', '--output-schema', '/w/schema.json', '-o', '/w/answer.json', '--model', 'm', '-c', 'model_reasoning_effort="high"', '-']);
    expect(c.input).toBe('plan it');
    expect(c.env).toEqual({ CODEX_HOME: '/h' });
    expect(new CodexProvider(runner).parseExecResult('', '{"a":1}')).toEqual({ a: 1 });

    const k = new ClaudeProvider(runner).buildExecCommand(exec);
    expect(k.args).toEqual(['-p', '--output-format', 'json', '--permission-mode', 'plan', '--json-schema', '{"type":"object"}', '--model', 'm', '--effort', 'high']);
    expect(k.env).toEqual({ CLAUDE_CONFIG_DIR: '/h' });
    const claude = new ClaudeProvider(runner);
    expect(claude.parseExecResult(JSON.stringify({ type: 'result', structured_output: { a: 1 }, result: 'x' }), null)).toEqual({ a: 1 });
    expect(claude.parseExecResult(JSON.stringify({ result: '```json\n{"b":2}\n```' }), null)).toEqual({ b: 2 });
    expect(() => claude.parseExecResult(JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: '' }), null)).toThrow(/error_max_turns/);
  });
});
