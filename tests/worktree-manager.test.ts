import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from '../src/core/git/git.js';
import { WorktreeManager } from '../src/core/worktrees/manager.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import { addBareRemote, commitFile, createRepo, git, tempDir } from './helpers.js';

const g = new Git(new NodeCommandRunner());

function setup() {
  const { root, parent } = createRepo('my-saas');
  const manager = new WorktreeManager(g, root);
  const wsDir = path.join(parent, '.agent-workspace', 'my-saas');
  const input = (agent: string, extra: Partial<Parameters<WorktreeManager['ensure']>[0]> = {}) => ({
    agent,
    project: 'my-saas',
    branch: `agent/${agent}`,
    base: 'main',
    remote: 'origin',
    path: path.join(wsDir, agent),
    ...extra,
  });
  return { root, parent, manager, wsDir, input };
}

describe('WorktreeManager.ensure', () => {
  it('creates a new branch and worktree from the base branch, with an ownership marker', async () => {
    const { root, manager, input } = setup();
    const result = await manager.ensure(input('backend'));
    expect(result.source).toBe('new-branch');
    expect(result.createdFrom).toBe('main');
    expect(existsSync(path.join(result.path, 'README.md'))).toBe(true);
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent/backend');
    // No upstream is configured for new agent branches (pushes are explicit).
    expect(() => git(root, 'rev-parse', '--abbrev-ref', 'agent/backend@{upstream}')).toThrow();
    const marker = await manager.readMarker(result.path);
    expect(marker).toMatchObject({ tool: 'agent-workspace', agent: 'backend', branch: 'agent/backend' });
    // The marker lives in the worktree's git dir, not in the working tree.
    expect(git(result.path, 'status', '--porcelain')).toBe('');
  });

  it('is idempotent: an existing worktree for the same agent is reused', async () => {
    const { manager, input } = setup();
    const first = await manager.ensure(input('backend'));
    const second = await manager.ensure(input('backend'));
    expect(second).toMatchObject({ path: first.path, source: 'existing-worktree', adopted: false });
  });

  it('uses an existing local branch', async () => {
    const { root, manager, input } = setup();
    git(root, 'branch', 'feat/db');
    const result = await manager.ensure(input('database', { branch: 'feat/db' }));
    expect(result.source).toBe('local-branch');
  });

  it('continues from a pushed remote branch (recreating the environment on another machine)', async () => {
    const { root, manager, input } = setup();
    addBareRemote(root);
    git(root, 'checkout', '-q', '-b', 'agent/api');
    commitFile(root, 'api.txt', 'remote work\n');
    git(root, 'push', '-q', 'origin', 'agent/api');
    git(root, 'checkout', '-q', 'main');
    git(root, 'branch', '-q', '-D', 'agent/api');
    const result = await manager.ensure(input('api'));
    expect(result.source).toBe('remote-branch');
    expect(result.createdFrom).toBe('origin/agent/api');
    expect(existsSync(path.join(result.path, 'api.txt'))).toBe(true);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'agent/api@{upstream}').trim()).toBe('origin/agent/api');
  });

  it('refuses a branch that is checked out in another worktree', async () => {
    const { root, parent, manager, input } = setup();
    git(root, 'worktree', 'add', '-q', '-b', 'agent/web', path.join(parent, 'manual-web'));
    await expect(manager.ensure(input('web'))).rejects.toThrow(/already checked out at/);
  });

  it('refuses to overwrite a non-empty directory that is not a worktree', async () => {
    const { manager, input, wsDir } = setup();
    mkdirSync(path.join(wsDir, 'admin'), { recursive: true });
    writeFileSync(path.join(wsDir, 'admin', 'precious.txt'), 'do not touch');
    await expect(manager.ensure(input('admin'))).rejects.toThrow(/Refusing to overwrite/);
    expect(existsSync(path.join(wsDir, 'admin', 'precious.txt'))).toBe(true);
  });

  it('refuses a worktree at the target path that is on a different branch', async () => {
    const { root, manager, input } = setup();
    const target = input('admin').path;
    git(root, 'worktree', 'add', '-q', '-b', 'something-else', target);
    await expect(manager.ensure(input('admin'))).rejects.toThrow(/expects branch "agent\/admin"/);
  });

  it('adopts an unmarked worktree on the right branch only with consent', async () => {
    const { root, manager, input } = setup();
    const target = input('auth').path;
    git(root, 'worktree', 'add', '-q', '-b', 'agent/auth', target);
    await expect(manager.ensure(input('auth'))).rejects.toThrow(/not created by Agent Workspace/);
    await expect(manager.ensure(input('auth', { confirmAdopt: async () => false }))).rejects.toThrow(/not created/);
    const result = await manager.ensure(input('auth', { confirmAdopt: async () => true }));
    expect(result).toMatchObject({ source: 'existing-worktree', adopted: true });
    expect((await manager.readMarker(target))?.agent).toBe('auth');
  });

  it('rejects invalid branch names and missing base branches', async () => {
    const { manager, input } = setup();
    await expect(manager.ensure(input('x', { branch: 'bad..branch' }))).rejects.toThrow(/not a valid Git branch name/);
    await expect(manager.ensure(input('y', { base: 'nope' }))).rejects.toThrow(/Base branch "nope" was not found locally\./);
  });

  it('distinguishes managed and user-created worktrees', async () => {
    const { root, parent, manager, input } = setup();
    await manager.ensure(input('backend'));
    git(root, 'worktree', 'add', '-q', '-b', 'mine', path.join(parent, 'mine'));
    const list = await manager.list();
    const byPath = Object.fromEntries(list.map((w) => [path.basename(w.entry.path), w.marker?.agent ?? null]));
    expect(byPath).toMatchObject({ 'my-saas': null, backend: 'backend', mine: null });
  });
});

describe('WorktreeManager.remove', () => {
  it('treats build and dependency directories as regenerable, other ignored files not', async () => {
    const { isRegenerable } = await import('../src/core/worktrees/manager.js');
    for (const f of ['node_modules/', 'apps/web/node_modules/', 'dist/', '.next/', '__pycache__/', 'x.pyc', '.venv/', 'tsconfig.tsbuildinfo']) {
      expect(isRegenerable(f), f).toBe(true);
    }
    for (const f of ['.env', 'data/local.db', 'secrets/', 'notes.txt']) expect(isRegenerable(f), f).toBe(false);
  });

  it('refuses to remove a worktree with uncommitted or untracked changes', async () => {
    const { manager, input } = setup();
    const { path: wt } = await manager.ensure(input('backend'));
    writeFileSync(path.join(wt, 'untracked.txt'), 'work in progress');
    await expect(manager.remove(wt, 'backend')).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(path.join(wt, 'untracked.txt'))).toBe(true);
  });

  it('refuses to remove worktrees not created by Agent Workspace', async () => {
    const { root, parent, manager } = setup();
    const mine = path.join(parent, 'mine');
    git(root, 'worktree', 'add', '-q', '-b', 'mine', mine);
    await expect(manager.remove(mine, 'mine')).rejects.toThrow(/not managed by Agent Workspace/);
    expect(existsSync(mine)).toBe(true);
  });

  it('refuses locked worktrees', async () => {
    const { root, manager, input } = setup();
    const { path: wt } = await manager.ensure(input('backend'));
    git(root, 'worktree', 'lock', wt);
    await expect(manager.remove(wt, 'backend')).rejects.toThrow(/locked/);
  });

  it('removes a clean managed worktree and keeps the branch and its commits', async () => {
    const { root, manager, input } = setup();
    const { path: wt } = await manager.ensure(input('backend'));
    commitFile(wt, 'feature.txt', 'done\n');
    await manager.remove(wt, 'backend');
    expect(existsSync(wt)).toBe(false);
    expect(git(root, 'log', '--format=%s', '-1', 'agent/backend').trim()).toBe('update feature.txt');
  });

  it('rejects paths that are not worktrees', async () => {
    const { manager } = setup();
    await expect(manager.remove(tempDir(), 'x')).rejects.toThrow(/not a registered worktree/);
  });
});
