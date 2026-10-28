import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { Git } from '../src/core/git/git.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import type { Prompter } from '../src/infrastructure/terminal/prompt.js';
import {
  type CapturedUi,
  ScriptedPrompter,
  captureUi,
  commitFile,
  createRepo,
  fakeAgentCli,
  git,
  hasTmux,
  killTmuxServer,
  tempDir,
  waitFor,
} from './helpers.js';

/**
 * End-to-end tests: the real CLI (in-process), real Git repositories, a real
 * but private tmux server, and fake agent CLIs that record their arguments.
 */

const socket = `aw-e2e-${process.pid}`;
const env = { ...process.env, AW_TMUX_SOCKET: socket };

interface Ctx {
  root: string;
  parent: string;
  codexLog: string;
  claudeLog: string;
  ui: CapturedUi;
}

let ctx: Ctx;

async function aw(args: string[], options: { cwd?: string; prompter?: Prompter; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  ctx.ui = captureUi();
  return runCli(['node', 'aw', ...args], {
    cwd: options.cwd ?? ctx.root,
    env: options.env ?? env,
    ui: ctx.ui,
    prompter: options.prompter ?? new ScriptedPrompter(false),
    // The dashboard's status window re-invokes the CLI; inside vitest there is no CLI entry point.
    selfCommand: ['/bin/sh', '-c', 'exec sleep 300'],
  });
}

function wsPath(agent: string): string {
  return path.join(ctx.parent, '.agent-workspace', 'my-saas', agent);
}

async function statusJson(cwd?: string) {
  expect(await aw(['status', '--json'], cwd ? { cwd } : {})).toBe(0);
  return JSON.parse(ctx.ui.out.join('\n')) as {
    project: string;
    agents: Array<{ name: string; session: string; branch: string; worktreePath: string | null; ahead: number | null; changes: unknown }>;
  };
}

function readLog(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

async function initWithFakes(): Promise<void> {
  expect(await aw(['init', '--provider', 'codex'])).toBe(0);
  const bin = tempDir('aw-bin-');
  const codex = fakeAgentCli(bin, 'codex', '--model --cd --add-dir resume');
  const claude = fakeAgentCli(bin, 'claude', '--model --continue --add-dir');
  ctx.codexLog = codex.log;
  ctx.claudeLog = claude.log;
  const file = path.join(ctx.root, '.agents', 'workspace.yaml');
  const yaml = readFileSync(file, 'utf8').replace(
    '# Optional per-provider settings',
    `providers:\n  codex:\n    command: ${codex.path}\n  claude:\n    command: ${claude.path}\n\n# Optional per-provider settings`,
  );
  writeFileSync(file, yaml);
}

describe.runIf(hasTmux())('aw end-to-end', () => {
  beforeEach(() => {
    killTmuxServer(socket);
    const { root, parent } = createRepo('my-saas');
    ctx = { root, parent, codexLog: '', claudeLog: '', ui: captureUi() };
  });
  afterAll(() => killTmuxServer(socket));

  it('init creates versionable configuration and refuses to run twice', async () => {
    expect(await aw(['init', '--name', 'my-saas', '--provider', 'claude'])).toBe(0);
    expect(ctx.ui.text()).toContain('Created .agents/workspace.yaml');
    expect(readFileSync(path.join(ctx.root, '.agents', 'workspace.yaml'), 'utf8')).toContain('provider: claude');
    expect(existsSync(path.join(ctx.root, '.agents', 'tasks', '.gitkeep'))).toBe(true);
    // Nothing machine-specific is written into the repository.
    expect(git(ctx.root, 'status', '--porcelain')).toBe('?? .agents/\n');
    expect(await aw(['init'])).toBe(2);
    expect(ctx.ui.text()).toMatch(/Already initialized/);
  });

  it('explains that a brand-new repository needs a first commit before spawning', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'fresh');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'master');
    ctx = { ...ctx, root, parent };
    expect(await aw(['init', '--provider', 'claude'])).toBe(0);
    expect(ctx.ui.err.join('\n')).toMatch(/no commits yet/);
    expect(ctx.ui.out.join('\n')).toMatch(/Next steps:\n {2}git add \.agents && git commit/);
    expect(await aw(['spawn', 'database', '-t', 'Schema'])).toBe(2);
    expect(ctx.ui.text()).toMatch(/no commits yet, so there is nothing to branch/);
    expect(ctx.ui.text()).toMatch(/git add \.agents && git commit/);
    expect(ctx.ui.text()).not.toMatch(/git fetch/);
    // After the first commit, spawning works.
    git(root, 'add', '.agents');
    git(root, 'commit', '-q', '-m', 'Add Agent Workspace configuration');
    const bin = tempDir('aw-bin-');
    const claude = fakeAgentCli(bin, 'claude', '--model --continue --add-dir');
    const file = path.join(root, '.agents', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('# Optional per-provider settings', `providers:\n  claude:\n    command: ${claude.path}\n\n# Optional per-provider settings`));
    expect(await aw(['spawn', 'database'])).toBe(0);
    expect(ctx.ui.text()).toContain('Worktree created (new branch agent/database from master)');
  });

  it('commands outside an initialized repo fail with actionable errors', async () => {
    expect(await aw(['status'])).toBe(2);
    expect(ctx.ui.text()).toMatch(/aw init/);
    expect(await aw(['status'], { cwd: tempDir() })).toBe(2);
    expect(ctx.ui.text()).toMatch(/Not inside a Git repository/);
    expect(await aw(['spawn', 'Bad Name'])).toBe(2);
    expect(await aw(['bogus-command'])).toBe(2);
  });

  it('reports invalid configuration with field-level details', async () => {
    await initWithFakes();
    writeFileSync(path.join(ctx.root, '.agents', 'workspace.yaml'), 'version: 1\nproject:\n  name: x\nagents:\n  api:\n    provider: nope\n');
    expect(await aw(['status'])).toBe(2);
    expect(ctx.ui.text()).toMatch(/agents\.api\.provider: unknown provider "nope"/);
  });

  it('runs the full agent lifecycle safely', async () => {
    await initWithFakes();

    // spawn a Codex agent (added to config on the fly) and a Claude agent
    expect(await aw(['spawn', 'backend', '--provider', 'codex', '--task', 'Build the REST API for users'])).toBe(0);
    expect(ctx.ui.text()).toContain('Worktree created (new branch agent/backend from main)');
    expect(ctx.ui.text()).toContain('Agent started successfully.');
    expect(await aw(['add', 'auth', '-p', 'claude', '-t', 'JWT authentication', '--depends-on', 'backend', '--scope', 'src/auth/**'])).toBe(0);
    expect(await aw(['spawn', 'auth', '--model', 'sonnet'])).toBe(0);
    expect(ctx.ui.err.join('\n')).toMatch(/Depends on "backend"/);

    await waitFor(() => readLog(ctx.codexLog).includes('---') && readLog(ctx.claudeLog).includes('---'));
    const codexLog = readLog(ctx.codexLog);
    expect(codexLog).toContain(`cwd=${wsPath('backend')}`);
    expect(codexLog).toContain('agent=backend');
    expect(codexLog).toContain(`arg=--cd\narg=${wsPath('backend')}`);
    expect(codexLog).toContain('Build the REST API for users');
    const claudeLog = readLog(ctx.claudeLog);
    expect(claudeLog).toContain(`cwd=${wsPath('auth')}`);
    expect(claudeLog).toContain('arg=--model\narg=sonnet');
    expect(claudeLog).toContain('JWT authentication');
    expect(claudeLog).toContain('backend (agent/backend): NOT yet merged');

    // config is updated, runtime state is not in the repo
    const yaml = readFileSync(path.join(ctx.root, '.agents', 'workspace.yaml'), 'utf8');
    expect(yaml).toMatch(/backend:\n\s+provider: codex\n\s+branch: agent\/backend\n\s+task: tasks\/backend.md/);
    expect(existsSync(path.join(ctx.root, '.git', 'agent-workspace', 'state.json'))).toBe(true);

    let status = await statusJson();
    expect(status.agents.map((a) => [a.name, a.session, a.branch])).toEqual([
      ['backend', 'running', 'agent/backend'],
      ['auth', 'running', 'agent/auth'],
    ]);

    // spawning a running agent is a no-op
    expect(await aw(['spawn', 'backend'])).toBe(0);
    expect(ctx.ui.text()).toContain('already running');

    // stop requires confirmation; declining aborts with 130 and keeps it running
    expect(await aw(['stop', 'backend'])).toBe(130);
    expect((await statusJson()).agents[0]?.session).toBe('running');
    expect(await aw(['stop', 'backend', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toContain('Worktree preserved');
    status = await statusJson();
    expect(status.agents[0]).toMatchObject({ name: 'backend', session: 'stopped', worktreePath: wsPath('backend') });
    expect(existsSync(wsPath('backend'))).toBe(true);

    // resume continues the provider's previous conversation
    expect(await aw(['spawn', 'backend', '--resume'])).toBe(0);
    await waitFor(() => readLog(ctx.codexLog).includes('arg=resume'));
    expect(readLog(ctx.codexLog)).toContain('arg=resume\narg=--last');

    // work in the worktree
    commitFile(wsPath('backend'), 'src/api/users.ts', 'export const users = [];\n', 'Add users API');
    writeFileSync(path.join(wsPath('backend'), 'scratch.txt'), 'uncommitted');
    status = await statusJson();
    expect(status.agents[0]).toMatchObject({ ahead: 1, changes: { untracked: 1 } });

    // cleanup never deletes uncommitted work
    expect(await aw(['cleanup', 'backend', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/uncommitted changes; refusing to clean up/);
    expect(existsSync(path.join(wsPath('backend'), 'scratch.txt'))).toBe(true);

    rmSync(path.join(wsPath('backend'), 'scratch.txt'));
    expect(await aw(['cleanup', 'backend', '--yes', '--delete-branch'])).toBe(0);
    expect(existsSync(wsPath('backend'))).toBe(false);
    // unmerged branch is kept even with --delete-branch
    expect(ctx.ui.text()).toMatch(/Branch agent\/backend was kept/);
    expect(git(ctx.root, 'log', '-1', '--format=%s', 'agent/backend').trim()).toBe('Add users API');
    status = await statusJson();
    expect(status.agents[0]).toMatchObject({ name: 'backend', session: 'not-spawned', worktreePath: null });

    // respawning continues from the existing branch
    expect(await aw(['spawn', 'backend', '--no-prompt'])).toBe(0);
    expect(ctx.ui.text()).toContain('Worktree created (existing branch agent/backend)');
    expect(existsSync(path.join(wsPath('backend'), 'src', 'api', 'users.ts'))).toBe(true);
  });

  it('works from inside an agent worktree and honours AW_WORKSPACE_DIR', async () => {
    await initWithFakes();
    const custom = tempDir('aw-custom-ws-');
    const customEnv = { ...env, AW_WORKSPACE_DIR: custom };
    expect(await aw(['spawn', 'api', '-t', 'API'], { env: customEnv })).toBe(0);
    const wt = path.join(custom, 'my-saas', 'api');
    expect(existsSync(path.join(wt, 'README.md'))).toBe(true);
    const status = await statusJson(wt);
    expect(status.project).toBe('my-saas');
    expect(status.agents[0]?.worktreePath).toBe(wt);
  });

  it('refuses to spawn an agent whose branch is checked out elsewhere', async () => {
    await initWithFakes();
    git(ctx.root, 'worktree', 'add', '-q', '-b', 'agent/web', path.join(ctx.parent, 'manual'));
    expect(await aw(['spawn', 'web', '-t', 'Web'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/already checked out at/);
  });

  it('recovers from interrupted operations', async () => {
    await initWithFakes();
    // Interrupted spawn: the worktree exists (unmarked), but no state or session.
    git(ctx.root, 'worktree', 'add', '-q', '-b', 'agent/db', wsPath('db'));
    expect(await aw(['spawn', 'db', '-t', 'Schema'])).toBe(4); // adoption needs consent
    expect(ctx.ui.text()).toMatch(/not created by Agent Workspace/);
    expect(await aw(['spawn', 'db', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toContain('Worktree recovered');

    // Lost runtime state: repair re-adopts marked worktrees and clears stale records.
    killTmuxServer(socket);
    rmSync(path.join(ctx.root, '.git', 'agent-workspace', 'state.json'));
    writeFileSync(
      path.join(ctx.root, '.git', 'agent-workspace', 'agents', 'db', 'agent.lock'),
      JSON.stringify({ pid: 999999, hostname: (await import('node:os')).hostname(), purpose: 'x', createdAt: '' }),
    );
    expect(await aw(['repair', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/Removed stale lock/);
    expect(ctx.ui.text()).toMatch(/Re-adopted worktree for "db"/);
    const status = await statusJson();
    expect(status.agents[0]).toMatchObject({ name: 'db', session: 'stopped', worktreePath: wsPath('db') });

    // Worktree deleted behind our back: repair forgets it and prunes Git metadata; branch survives.
    rmSync(wsPath('db'), { recursive: true, force: true });
    expect(await aw(['repair', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/Forgot "db"/);
    expect(git(ctx.root, 'worktree', 'list')).not.toContain(wsPath('db'));
    expect(git(ctx.root, 'branch', '--list', 'agent/db')).toContain('agent/db');

    // A missing worktree that aw did not create is reported, never pruned.
    const mine = path.join(ctx.parent, 'usb-drive-worktree');
    git(ctx.root, 'worktree', 'add', '-q', '-b', 'mine', mine);
    rmSync(mine, { recursive: true, force: true });
    expect(await aw(['repair', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/not created by aw\) is missing; left untouched/);
    expect(git(ctx.root, 'worktree', 'list', '--porcelain')).toContain(mine);
  });

  it('cleanup refuses to lose ignored files or commits outside the agent branch', async () => {
    await initWithFakes();
    writeFileSync(path.join(ctx.root, '.gitignore'), 'node_modules/\n.env\n');
    git(ctx.root, 'add', '.');
    git(ctx.root, 'commit', '-q', '-m', 'ignore');
    expect(await aw(['spawn', 'api', '-t', 'API'])).toBe(0);
    const wt = wsPath('api');
    // Regenerable artifacts are fine; a local .env is not.
    mkdirSync(path.join(wt, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(wt, 'node_modules', 'x', 'index.js'), '');
    writeFileSync(path.join(wt, '.env'), 'SECRET=1');
    expect(await aw(['cleanup', 'api', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/ignored files that would be deleted/);
    expect(ctx.ui.text()).toContain('.env');
    expect(existsSync(path.join(wt, '.env'))).toBe(true);
    rmSync(path.join(wt, '.env'));

    // Commits on a detached HEAD would be lost with the worktree's reflog.
    git(wt, 'checkout', '-q', '--detach');
    commitFile(wt, 'detached.txt', 'precious\n');
    expect(await aw(['cleanup', 'api', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/detached HEAD with commits not contained in any branch/);
    git(wt, 'switch', '-q', '-c', 'agent/api-saved');
    expect(await aw(['cleanup', 'api', '--yes'])).toBe(0);
    expect(git(ctx.root, 'log', '-1', '--format=%s', 'agent/api-saved').trim()).toBe('update detached.txt');
  });

  it('warns when the committed configuration runs custom executables or disables sandboxes', async () => {
    await initWithFakes();
    const file = path.join(ctx.root, '.agents', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('agents: {}', 'agents:\n  api:\n    args: ["--dangerously-bypass-approvals-and-sandbox"]'));
    expect(await aw(['spawn', 'api', '--no-prompt'])).toBe(0);
    expect(ctx.ui.err.join('\n')).toMatch(/runs a custom executable for codex/);
    expect(ctx.ui.err.join('\n')).toMatch(/disable the agent's sandbox\/approvals: --dangerously-bypass-approvals-and-sandbox/);
  });

  it('reports overlaps and conflicts between agents without modifying anything', async () => {
    await initWithFakes();
    expect(await aw(['add', 'api', '-t', 'API', '--scope', 'src/api/**'])).toBe(0);
    expect(await aw(['add', 'auth', '-t', 'Auth', '--scope', 'src/api/auth/**'])).toBe(0);
    expect(await aw(['spawn', 'api', '--no-prompt'])).toBe(0);
    expect(await aw(['spawn', 'auth', '--no-prompt'])).toBe(0);
    commitFile(wsPath('api'), 'src/shared/types.ts', 'export type User = { id: string };\n');
    commitFile(wsPath('auth'), 'src/shared/types.ts', 'export type User = { id: number };\n');
    const before = git(ctx.root, 'rev-parse', 'agent/api', 'agent/auth');

    const mergeSimulation = await new Git(new NodeCommandRunner()).supportsMergeTree();
    expect(await aw(['check', '--strict'])).toBe(mergeSimulation ? 4 : 0);
    const text = ctx.ui.text();
    expect(text).toMatch(/Declared scopes of api and auth overlap/);
    expect(text).toMatch(/api changed 1 file\(s\) outside its declared scope/);
    // Git >= 2.38 simulates the merge; older Git still reports the shared file.
    expect(text).toMatch(mergeSimulation ? /api and auth have conflicting changes/ : /api and auth both modified 1 file\(s\)/);
    expect(text).toContain('src/shared/types.ts');
    expect(git(ctx.root, 'rev-parse', 'agent/api', 'agent/auth')).toBe(before);
    expect(await aw(['check', '--json'])).toBe(0);
    expect(JSON.parse(ctx.ui.out.join('\n')).issues.length).toBeGreaterThan(0);
  });

  it('opens a dashboard of running agents and closes it without stopping them', async () => {
    await initWithFakes();
    expect(await aw(['dashboard', '--no-attach'])).toBe(1);
    expect(ctx.ui.text()).toMatch(/No agents are running/);
    expect(await aw(['spawn', 'a', '-t', 'A'])).toBe(0);
    expect(await aw(['spawn', 'b', '-t', 'B', '-p', 'claude'])).toBe(0);
    expect(await aw(['dashboard', '--no-attach'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/Dashboard ready with 2 agent\(s\): a, b/);
    expect(await aw(['dashboard', '--kill'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/Agents are still running/);
    const status = await statusJson();
    expect(status.agents.map((a) => a.session)).toEqual(['running', 'running']);
  });

  it('restarts an exited agent in place, so attached clients and dashboard panes stay connected', async () => {
    await initWithFakes();
    expect(await aw(['spawn', 'a', '-t', 'Build A'])).toBe(0);
    expect(await aw(['dashboard', '--no-attach'])).toBe(0);
    const session = (await statusJson()).agents[0] as unknown as { sessionName: string };
    const tmux = (...args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
    const dashboard = tmux('list-sessions', '-F', '#{session_name}').split('\n').find((n) => n.endsWith('--dashboard')) as string;
    expect(tmux('list-windows', '-t', `=${dashboard}`, '-F', '#{window_name}').trim().split('\n')).toEqual(['agents', 'status', 'shell']);

    // The agent CLI exits (e.g. Ctrl-C after a failed login).
    expect(await aw(['tell', 'a', 'exit'])).toBe(0);
    await waitFor(async () => (await statusJson()).agents[0]?.session === 'exited');
    // Typing into an exited agent would run commands in its shell: refused.
    expect(await aw(['tell', 'a', 'rm -rf something'])).toBe(4);

    expect(await aw(['spawn', 'a'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/relaunched in its existing tmux session/);
    await waitFor(async () => (await statusJson()).agents[0]?.session === 'running');
    expect(((await statusJson()).agents[0] as unknown as { sessionName: string }).sessionName).toBe(session.sessionName);
    expect(tmux('list-panes', '-t', `=${dashboard}:agents`, '-F', '#{pane_dead}').trim()).toBe('0');

    expect(await aw(['tell', 'a', 'hello', 'agent'])).toBe(0);
    await waitFor(() => readLog(ctx.codexLog).includes('got: hello agent'));

    // restart interrupts a running agent (after confirmation) and relaunches in the same session.
    const launchesBefore = readLog(ctx.codexLog).split('---').length;
    expect(await aw(['restart', 'a'])).toBe(130); // declined
    expect(await aw(['restart', 'a', '--yes', '--resume'])).toBe(0);
    await waitFor(() => readLog(ctx.codexLog).split('---').length > launchesBefore);
    expect(readLog(ctx.codexLog)).toContain('arg=resume');
    expect(tmux('list-panes', '-t', `=${dashboard}:agents`, '-F', '#{pane_dead}').trim()).toBe('0');
  });

  it('syncs the base branch into an agent branch and hands conflicts to the agent', async () => {
    await initWithFakes();
    git(ctx.root, 'add', '.agents');
    git(ctx.root, 'commit', '-q', '-m', 'config');
    expect(await aw(['spawn', 'a', '-t', 'A'])).toBe(0);
    expect(await aw(['sync', 'a', '--yes'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/already up to date/);

    // Clean merge
    commitFile(ctx.root, 'docs/contract.md', 'v1\n');
    expect(await aw(['sync', 'a', '--yes'])).toBe(0);
    expect(existsSync(path.join(wsPath('a'), 'docs', 'contract.md'))).toBe(true);

    // Conflict: left in place, listed, and (with --ask-agent) handed to the agent
    commitFile(wsPath('a'), 'src/app.ts', 'agent version\n');
    commitFile(ctx.root, 'src/app.ts', 'main version\n');
    writeFileSync(path.join(wsPath('a'), 'wip.txt'), 'x');
    expect(await aw(['sync', 'a', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/uncommitted changes; commit them before syncing/);
    rmSync(path.join(wsPath('a'), 'wip.txt'));
    expect(await aw(['sync', 'a', '--yes', '--ask-agent'])).toBe(0);
    expect(ctx.ui.text()).toMatch(/conflicts in 1 file/);
    expect(ctx.ui.text()).toContain('src/app.ts');
    await waitFor(() => readLog(ctx.codexLog).includes('merge conflicts in: src/app.ts'));
    expect(readFileSync(path.join(wsPath('a'), 'src', 'app.ts'), 'utf8')).toContain('<<<<<<<');
    expect(await aw(['sync', 'a', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/merge is already in progress/);
  });

  it('opens or prints the task file for editing', async () => {
    await initWithFakes();
    expect(await aw(['edit', 'ghost'])).toBe(2);
    expect(await aw(['add', 'api'])).toBe(0);
    expect(await aw(['edit', 'api'])).toBe(0); // no TTY in tests: prints the path
    expect(ctx.ui.out.join('\n')).toContain(path.join(ctx.root, '.agents', 'tasks', 'api.md'));
  });

  it('handles files: local copies, shared inbox/outbox, input files in the prompt', async () => {
    await initWithFakes();
    // Local files: .env is ignored and copied; config.local.json is NOT ignored, so it is refused.
    writeFileSync(path.join(ctx.root, '.gitignore'), '.env\n');
    writeFileSync(path.join(ctx.root, '.env'), 'DATABASE_URL=postgres://localhost/dev\n');
    writeFileSync(path.join(ctx.root, 'config.local.json'), '{}');
    git(ctx.root, 'add', '.gitignore');
    git(ctx.root, 'commit', '-q', '-m', 'ignore env');
    const file = path.join(ctx.root, '.agents', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('  copyFiles: []', '  copyFiles: [".env", "config.local.json"]'));

    const spec = path.join(tempDir('aw-input-'), 'spec.md');
    writeFileSync(spec, '# Billing spec\n');
    expect(await aw(['spawn', 'api', '-t', 'Build billing', '--file', spec])).toBe(0);
    const text = ctx.ui.text();
    expect(text).toContain('Local files copied: .env');
    expect(text).toMatch(/Not copied \(not git-ignored.*config\.local\.json/);
    expect(readFileSync(path.join(wsPath('api'), '.env'), 'utf8')).toContain('DATABASE_URL');
    expect(git(wsPath('api'), 'status', '--porcelain')).toBe('');

    const shared = path.join(ctx.parent, '.agent-workspace', 'my-saas', '.shared');
    expect(readFileSync(path.join(shared, 'inbox', 'api', 'spec.md'), 'utf8')).toBe('# Billing spec\n');
    await waitFor(() => readLog(ctx.codexLog).includes('---'));
    const log = readLog(ctx.codexLog);
    expect(log).toContain(`arg=--add-dir\narg=${shared}`);
    expect(log).toContain(path.join(shared, 'inbox', 'api', 'spec.md'));
    expect(log).toContain(path.join(shared, 'outbox', 'api'));
    expect(log).toMatch(/arg=--\narg=You are the "api" agent/);

    // aw files add / list / path, and --tell
    const data = path.join(tempDir('aw-input-'), 'data.csv');
    writeFileSync(data, 'a,b\n');
    expect(await aw(['files', 'add', data])).toBe(0);
    expect(await aw(['files', 'add', data])).toBe(0); // identical: reused, not duplicated
    expect(await aw(['files', 'add', spec, '--agent', 'api', '--tell'])).toBe(0);
    await waitFor(() => readLog(ctx.codexLog).includes('got: New input file(s) for you'));
    writeFileSync(path.join(shared, 'outbox', 'api', 'report.md'), '# Report\n');
    expect(await aw(['files'])).toBe(0);
    const listing = ctx.ui.out.join('\n');
    expect(listing).toContain('data.csv');
    expect(listing).not.toContain('data (2).csv');
    expect(listing).toContain('api/spec.md');
    expect(listing).toMatch(/Outbox: api\n {2}report\.md/);
    expect(await aw(['files', 'path', '--agent', 'api', '--outbox'])).toBe(0);
    expect(ctx.ui.out.join('\n').trim()).toBe(path.join(shared, 'outbox', 'api'));

    // Cleanup: an unchanged copied .env is disposable; an edited one is protected.
    writeFileSync(path.join(wsPath('api'), '.env'), 'DATABASE_URL=changed-by-agent\n');
    expect(await aw(['cleanup', 'api', '--yes'])).toBe(4);
    expect(ctx.ui.text()).toMatch(/ignored files that would be deleted/);
    writeFileSync(path.join(wsPath('api'), '.env'), 'DATABASE_URL=postgres://localhost/dev\n');
    expect(await aw(['cleanup', 'api', '--yes'])).toBe(0);
    // The shared area survives cleanup.
    expect(existsSync(path.join(shared, 'outbox', 'api', 'report.md'))).toBe(true);
  });

  it('prints help and version', async () => {
    expect(await aw(['--version'])).toBe(0);
    expect(await aw(['spawn', '--help'])).toBe(0);
  });
});
