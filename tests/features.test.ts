import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultDeps, type Deps } from '../src/core/deps.js';
import { FeatureService } from '../src/core/features/service.js';
import { switchAccount } from '../src/core/agents/handoff.js';
import { runCli } from '../src/cli/run.js';
import type { Plan } from '../src/core/features/plan.js';
import { ScriptedPrompter, captureUi, createRepo, git, hasTmux, killTmuxServer, tempDir, waitFor } from './helpers.js';

/**
 * Feature orchestration end to end: a fake Codex CLI plays both the planner
 * (codex exec → plan JSON) and the agents (interactive, recording argv);
 * the tests play the agents' work by committing in their worktrees and
 * writing status reports.
 */

const socket = `aw-features-${process.pid}`;

function fakeCodex(dir: string): { path: string; log: string } {
  const file = path.join(dir, 'codex');
  const log = path.join(dir, 'codex.log');
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex 9.9.9"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--model --cd --add-dir resume"; exit 0; fi
if [ "$1" = "exec" ]; then
  out=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "-o" ]; then out="$a"; fi
    prev="$a"
  done
  { echo "exec home=$CODEX_HOME"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; echo "stdin:"; cat; echo "---"; } >> "${log}"
  if [ -n "$FAKE_PLAN_FAIL" ]; then echo "planner exploded" >&2; exit 4; fi
  cp "$FAKE_PLAN" "$out"
  exit 0
fi
{ echo "cwd=$(pwd)"; echo "agent=$AW_AGENT"; echo "home=$CODEX_HOME"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; echo "---"; } >> "${log}"
while read line; do
  echo "got: $line" >> "${log}"
done
`,
  );
  chmodSync(file, 0o755);
  return { path: file, log };
}

function plan(tasks: Array<Partial<Plan['tasks'][number]> & { id: string }>): Plan {
  return {
    title: 'Greeting module',
    summary: 'Add a greeting module and a CLI that uses it.',
    approach: 'Core first, then the CLI.',
    questions: [],
    tasks: tasks.map((t) => ({
      title: `Task ${t.id}`,
      objective: `Implement ${t.id}`,
      context: '',
      scope: [`${t.id}/**`],
      dependsOn: [],
      acceptance: ['works'],
      validation: [],
      complexity: 'low',
      risk: 'low',
      rationale: 'small',
      suggestedProvider: 'codex',
      suggestedEffort: 'low',
      ...t,
    })),
  };
}

interface Ctx {
  root: string;
  parent: string;
  deps: Deps;
  service: FeatureService;
  log: string;
  planFile: string;
  homes: { a: string; b: string };
}

let ctx: Ctx;

function makeDeps(root: string, env: NodeJS.ProcessEnv, dataDir: string): Deps {
  return createDefaultDeps({
    cwd: root,
    env,
    ui: captureUi(),
    prompter: new ScriptedPrompter(false),
    dataDir,
    selfCommand: ['/bin/sh', '-c', 'exec sleep 300'],
  });
}

async function setup(tasks: Parameters<typeof plan>[0], extraConfig = ''): Promise<void> {
  const { root, parent } = createRepo('shop');
  const bin = tempDir('aw-bin-');
  const codex = fakeCodex(bin);
  const dataDir = tempDir('aw-data-');
  const homes = { a: tempDir('codex-a-'), b: tempDir('codex-b-') };
  writeFileSync(
    path.join(dataDir, 'settings.yaml'),
    `accounts:
  codex-a: { provider: codex, home: ${homes.a}, tags: [personal] }
  codex-b: { provider: codex, home: ${homes.b}, tags: [work] }
routing:
  planner: { account: codex-b, effort: high }
  rules:
    - when: { complexity: low }
      use: { account: codex-a, effort: low }
    - when: {}
      use: { account: codex-b, effort: high }
`,
  );
  const planFile = path.join(bin, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan(tasks)));
  const env = { ...process.env, AW_TMUX_SOCKET: socket, AW_DATA_DIR: dataDir, FAKE_PLAN: planFile };
  expect(await runCli(['node', 'aw', 'init', '--provider', 'codex'], { cwd: root, env, ui: captureUi(), prompter: new ScriptedPrompter(false), dataDir })).toBe(0);
  const file = path.join(root, '.agents', 'workspace.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('# Optional per-provider settings', `providers:\n  codex:\n    command: ${codex.path}\n${extraConfig}\n# Optional per-provider settings`),
  );
  git(root, 'add', '.agents');
  git(root, 'commit', '-q', '-m', 'aw');
  const deps = makeDeps(root, env, dataDir);
  ctx = { root, parent, deps, service: new FeatureService(deps), log: codex.log, planFile, homes };
}

const worktree = (agent: string) => path.join(ctx.parent, '.agent-workspace', 'shop', agent);
const outbox = (agent: string) => path.join(ctx.parent, '.agent-workspace', 'shop', '.shared', 'outbox', agent);

function work(agent: string, file: string, content: string): void {
  const wt = worktree(agent);
  mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  writeFileSync(path.join(wt, file), content);
  git(wt, 'add', '-A');
  git(wt, 'commit', '-q', '-m', `work on ${file}`);
}

function report(agent: string, status: 'done' | 'blocked', extra: Record<string, unknown> = {}): void {
  mkdirSync(outbox(agent), { recursive: true });
  writeFileSync(path.join(outbox(agent), 'status.json'), JSON.stringify({ status, summary: `${agent} ${status}`, ...extra }));
}

const log = () => (existsSync(ctx.log) ? readFileSync(ctx.log, 'utf8') : '');

describe.runIf(hasTmux())('features', () => {
  beforeEach(() => killTmuxServer(socket));
  afterAll(() => killTmuxServer(socket));

  it('plans read-only, routes by the user policy, runs waves, answers questions and integrates into one feature branch', async () => {
    await setup([
      { id: 'core', validation: ['test -f core/greet.txt'] },
      { id: 'cli', dependsOn: ['core'], complexity: 'medium', scope: ['cli/**'], validation: ['test -f cli/main.txt', 'test -f core/greet.txt'] },
    ]);
    const s = ctx.service;
    const created = await s.create('Add a greeting module\nSee README.md for the tone.');
    expect(created.id).toBe('add-a-greeting');
    expect(created.planner.route).toMatchObject({ account: 'codex-b', effort: 'high' });

    const planned = await s.plan(created.id);
    expect(planned.status).toBe('review');
    expect(planned.title).toBe('Greeting module');
    // The planner ran read-only, with the planner account and a schema.
    expect(log()).toContain(`exec home=${ctx.homes.b}`);
    expect(log()).toContain('arg=read-only');
    expect(log()).toContain('arg=--output-schema');
    expect(log()).toContain('model_reasoning_effort="high"');
    expect(log()).toContain('PARALLELIZE ONLY WHEN IT PAYS');
    expect(log()).toContain('See README.md for the tone.');
    // Routing: rule 1 for the low task, rule 2 for the medium one.
    expect(planned.tasks.map((t) => [t.id, t.route.account, t.route.effort])).toEqual([
      ['core', 'codex-a', 'low'],
      ['cli', 'codex-b', 'high'],
    ]);
    expect(planned.tasks[0]?.route.reason).toMatch(/rule 1/);

    await s.setRoute(created.id, 'cli', { effort: 'medium' });
    // Nothing has touched the repository yet.
    expect(git(ctx.root, 'status', '--porcelain')).toBe('');

    const approved = await s.approve(created.id);
    expect(approved.status).toBe('running');
    expect(git(ctx.root, 'branch', '--list', 'feature/add-a-greeting')).toContain('feature/add-a-greeting');

    // Wave 1: only core starts, with its account and effort.
    await s.advance(created.id);
    let f = await (await s.open()).store.require(created.id);
    expect(f.tasks.map((t) => t.status)).toEqual(['running', 'pending']);
    await waitFor(() => log().includes('agent=add-a-greeting-core'));
    expect(log()).toContain(`home=${ctx.homes.a}`);
    expect(log()).toContain('model_reasoning_effort="low"');
    expect(log()).toContain('status.json'); // the reporting contract is in the prompt
    expect(git(worktree('add-a-greeting-core'), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/add-a-greeting--core');

    // core finishes → validated → integrated → cli starts from the updated feature branch.
    work('add-a-greeting-core', 'core/greet.txt', 'hello\n');
    report('add-a-greeting-core', 'done');
    await s.advance(created.id);
    f = await (await s.open()).store.require(created.id);
    expect(f.tasks.map((t) => t.status)).toEqual(['integrated', 'running']);
    expect(f.tasks[0]?.firstPass).toBe(true);
    expect(existsSync(path.join(worktree('add-a-greeting-cli'), 'core', 'greet.txt'))).toBe(true);
    expect(git(ctx.root, 'show', 'feature/add-a-greeting:core/greet.txt')).toBe('hello\n');
    expect(git(ctx.root, 'rev-parse', 'main')).toBe(git(ctx.root, 'rev-parse', 'main')); // main untouched
    expect(git(ctx.root, 'log', '--oneline', 'main')).not.toContain('work on');

    // cli asks a question; the answer is typed into its terminal.
    report('add-a-greeting-cli', 'blocked', { questions: ['English or Portuguese?'] });
    await s.advance(created.id);
    f = await (await s.open()).store.require(created.id);
    expect(f.tasks[1]).toMatchObject({ status: 'blocked', attention: 'English or Portuguese?' });
    await s.answer(created.id, 'cli', 'Portuguese');
    await waitFor(() => log().includes('got: Portuguese'));
    f = await (await s.open()).store.require(created.id);
    expect(f.tasks[1]?.status).toBe('running');

    // Validation failure is sent back to the agent; the fix passes.
    work('add-a-greeting-cli', 'cli/other.txt', 'x');
    report('add-a-greeting-cli', 'done');
    await s.advance(created.id);
    f = await (await s.open()).store.require(created.id);
    expect(f.tasks[1]).toMatchObject({ status: 'running', attempts: 1, firstPass: false });
    await waitFor(() => log().includes('got: Validation failed'));

    work('add-a-greeting-cli', 'cli/main.txt', 'olá\n');
    report('add-a-greeting-cli', 'done');
    await s.advance(created.id);
    f = await (await s.open()).store.require(created.id);
    expect(f.status).toBe('ready');
    expect(git(ctx.root, 'show', 'feature/add-a-greeting:cli/main.txt')).toBe('olá\n');
    const prBody = readFileSync(path.join((await s.open()).store.prFile(created.id)), 'utf8');
    expect(prBody).toContain('# Greeting module');
    expect(prBody).toContain('add-a-greeting-cli done');
    // Events were recorded.
    const events = await (await s.open()).store.events(created.id);
    expect(events.map((e) => e.text).join('\n')).toMatch(/Integrated into feature\/add-a-greeting/);
  });

  it('hands integration conflicts back to the agent and integrates the resolution', async () => {
    await setup([{ id: 'x', scope: ['README.md'] }, { id: 'y', scope: ['README.md'] }]);
    const s = ctx.service;
    const f0 = await s.create('Change the readme twice');
    await s.plan(f0.id);
    await s.approve(f0.id);
    await s.advance(f0.id); // both start (parallel)
    const [ax, ay] = ['change-the-x', 'change-the-y'].map((n) => n.replace('change-the', f0.id));
    work(ax as string, 'README.md', '# from x\n');
    work(ay as string, 'README.md', '# from y\n');
    report(ax as string, 'done');
    report(ay as string, 'done');
    await s.advance(f0.id);
    let f = await (await s.open()).store.require(f0.id);
    expect(f.tasks.map((t) => [t.id, t.status, t.conflicts])).toEqual([
      ['x', 'integrated', 0],
      ['y', 'running', 1],
    ]);
    // The feature branch was merged into y's worktree, conflict left for the agent.
    const wt = worktree(ay as string);
    expect(git(wt, 'diff', '--name-only', '--diff-filter=U').trim()).toBe('README.md');
    await waitFor(() => log().includes('got: I merged feature/'));
    // The agent resolves and reports again.
    writeFileSync(path.join(wt, 'README.md'), '# from x and y\n');
    git(wt, 'add', 'README.md');
    git(wt, 'commit', '-q', '--no-edit');
    report(ay as string, 'done');
    await s.advance(f0.id);
    f = await (await s.open()).store.require(f0.id);
    expect(f.status).toBe('ready');
    expect(git(ctx.root, 'show', `${f.branch}:README.md`)).toBe('# from x and y\n');
  });

  it('records planner failures, re-plans with feedback and keeps a route chosen by the user', async () => {
    await setup([{ id: 'only' }]);
    const s = ctx.service;
    const f0 = await s.create('Do one thing');
    process.env.FAKE_PLAN_FAIL = '1';
    ctx.deps.env.FAKE_PLAN_FAIL = '1';
    await expect(s.plan(f0.id)).rejects.toThrow(/exited with code 4/);
    let f = await (await s.open()).store.require(f0.id);
    expect(f.status).toBe('plan-failed');
    expect(f.planner.error).toMatch(/planner exploded/);
    delete process.env.FAKE_PLAN_FAIL;
    delete ctx.deps.env.FAKE_PLAN_FAIL;
    await s.plan(f0.id);
    await s.setRoute(f0.id, 'only', { account: 'codex-b', effort: 'max' });
    await s.replan(f0.id, 'Use a single task, keep it small');
    f = await (await s.open()).store.require(f0.id);
    expect(f.feedback).toEqual(['Use a single task, keep it small']);
    expect(f.tasks[0]?.route).toMatchObject({ account: 'codex-b', effort: 'max' });
    expect(log()).toContain('Use a single task, keep it small');
    expect(log()).toContain('Your previous plan (JSON)');
  });

  it('refuses accounts the project does not allow, and switches an agent with a handoff', async () => {
    await setup([{ id: 'only' }], 'accounts: [work]\n');
    const s = ctx.service;
    const f0 = await s.create('Do one thing');
    const planned = await s.plan(f0.id);
    // codex-a (personal) is not allowed: rule 1 is skipped, rule 2 applies.
    expect(planned.tasks[0]?.route.account).toBe('codex-b');
    expect(planned.tasks[0]?.route.warnings.join(' ')).toMatch(/rule 1 skipped: account "codex-a" is not allowed/);
    await expect(s.setRoute(f0.id, 'only', { account: 'codex-a' })).rejects.toThrow(/not allowed/);
    await s.approve(f0.id);
    await s.advance(f0.id);
    const agent = `${f0.id}-only`;
    await waitFor(() => log().includes(`agent=${agent}`));
    work(agent, 'only/a.txt', 'a');

    // Allow both to test the switch itself.
    const file = path.join(ctx.root, '.agents', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('accounts: [work]', 'accounts: [work, personal]'));
    await switchAccount(ctx.deps, ctx.service.agents, agent, 'codex-a');
    await waitFor(() => log().split('---').some((block) => block.includes(`agent=${agent}`) && block.includes(`home=${ctx.homes.a}`)));
    expect(log()).toContain('HANDOFF: you are continuing a task');
    expect(log()).toContain('work on only/a.txt');
    const f = await (await s.open()).store.require(f0.id);
    expect(f.tasks[0]?.route).toMatchObject({ account: 'codex-a', provider: 'codex' });
    expect(f.tasks[0]?.route.reason).toMatch(/switched by you from codex-b to codex-a/);
  });

  it('drives the whole flow from the CLI', async () => {
    await setup([{ id: 'only', validation: ['test -f only/a.txt'] }]);
    const ui = () => captureUi();
    let out = ui();
    const aw = async (...args: string[]) => {
      out = ui();
      return runCli(['node', 'aw', ...args], { cwd: ctx.root, env: ctx.deps.env, ui: out, prompter: new ScriptedPrompter(true), dataDir: ctx.deps.dataDir, selfCommand: ['/bin/sh', '-c', 'exec sleep 300'] });
    };
    expect(await aw('feature', 'new', 'Make', 'one', 'file')).toBe(0);
    expect(out.text()).toContain('# Tasks');
    expect(out.text()).toContain('aw feature approve make-one-file');
    expect(await aw('feature')).toBe(0);
    expect(out.text()).toMatch(/make-one-file\s+plan ready: review/);
    expect(await aw('feature', 'route', 'make', 'only', '--effort', 'xhigh')).toBe(0);
    expect(out.text()).toContain('only: codex-a (codex), effort xhigh');
    expect(await aw('feature', 'route', 'make', 'only', '--effort', 'huge')).toBe(2);
    expect(await aw('feature', 'approve', 'make')).toBe(0);
    expect(await aw('feature', 'watch', '--once')).toBe(0);
    await waitFor(() => log().includes('agent=make-one-file-only'));
    expect(log()).toContain('model_reasoning_effort="xhigh"');
    expect(await aw('status')).toBe(0);
    expect(out.text()).toContain('make-one-file-only');

    work('make-one-file-only', 'only/a.txt', 'a');
    report('make-one-file-only', 'done');
    expect(await aw('feature', 'watch', '--once')).toBe(0);
    expect(await aw('feature', 'show', 'make-one-file')).toBe(0);
    expect(out.text()).toContain('ready for PR');
    expect(out.text()).toMatch(/✓ only/);

    expect(await aw('accounts')).toBe(0);
    expect(out.text()).toMatch(/codex-a\s+codex\s+available/);
    expect(await aw('accounts', 'limited', 'codex-a', '--until', '2h', '--note', 'weekly cap')).toBe(0);
    expect(await aw('accounts')).toBe(0);
    expect(out.text()).toMatch(/codex-a\s+codex\s+limited until .*weekly cap/);
    expect(await aw('accounts', 'available', 'codex-a')).toBe(0);
    expect(await aw('accounts', 'add', 'claude-work', '--provider', 'claude', '--tag', 'work')).toBe(0);
    expect(await aw('accounts', '--json')).toBe(0);
    expect(JSON.parse(out.out.join('\n')).map((a: { name: string }) => a.name)).toContain('claude-work');
    expect(await aw('accounts', 'stats')).toBe(0);
    expect(out.text()).toContain('low complexity · codex · effort xhigh');
    expect(await aw('switch', 'make-one-file-only', 'codex-b', '-y')).toBe(0);
    expect(out.text()).toContain('now runs on codex-b');
    expect(await aw('feature', 'cleanup', 'make-one-file')).toBe(0);
    expect(out.text()).toMatch(/Removed: .*integration worktree/);
  });
});
