import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git, parseStatus, parseWorktreeList } from '../src/core/git/git.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import { commitFile, createRepo, git, tempDir } from './helpers.js';

const g = new Git(new NodeCommandRunner());

describe('git output parsing', () => {
  it('parses porcelain worktree lists', () => {
    const entries = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD abc',
        'branch refs/heads/main',
        '',
        'worktree /ws/backend',
        'HEAD def',
        'branch refs/heads/feat/backend',
        'locked reason',
        '',
        'worktree /ws/detached',
        'HEAD 123',
        'detached',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(entries.map((e) => [e.path, e.branch, e.locked, e.detached, e.prunable])).toEqual([
      ['/repo', 'main', false, false, false],
      ['/ws/backend', 'feat/backend', true, false, false],
      ['/ws/detached', null, false, true, true],
    ]);
  });

  it('parses porcelain status', () => {
    const status = parseStatus(['M  staged.ts', ' M modified.ts', 'MM both.ts', '?? new.ts', 'UU conflict.ts', ''].join('\n'));
    expect(status).toMatchObject({ staged: 2, unstaged: 2, untracked: 1, conflicted: 1, dirty: true });
    expect(parseStatus('').dirty).toBe(false);
  });
});

describe('repository detection', () => {
  it('detects the main working tree from a subdirectory', async () => {
    const { root } = createRepo();
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    const info = await g.detectRepository(path.join(root, 'src', 'deep'));
    expect(info.toplevel).toBe(root);
    expect(info.commonDir).toBe(path.join(root, '.git'));
    expect(info.isLinkedWorktree).toBe(false);
    expect(info.mainWorktree).toBe(root);
  });

  it('detects linked worktrees and resolves the common dir and main worktree', async () => {
    const { root, parent } = createRepo();
    const linked = path.join(parent, 'linked');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const info = await g.detectRepository(linked);
    expect(info.toplevel).toBe(linked);
    expect(info.isLinkedWorktree).toBe(true);
    expect(info.commonDir).toBe(path.join(root, '.git'));
    expect(info.mainWorktree).toBe(root);
  });

  it('supports bare repositories with linked worktrees', async () => {
    const { root, parent } = createRepo();
    const bare = path.join(parent, 'bare.git');
    git(parent, 'clone', '-q', '--bare', root, bare);
    const wt = path.join(parent, 'bare-main');
    git(bare, 'worktree', 'add', '-q', wt, 'main');
    const fromBare = await g.detectRepository(bare);
    expect(fromBare.isBare).toBe(true);
    expect(fromBare.toplevel).toBeNull();
    expect(fromBare.mainWorktree).toBeNull();
    const fromWt = await g.detectRepository(wt);
    expect(fromWt.toplevel).toBe(wt);
    expect(fromWt.commonDir).toBe(bare);
  });

  it('fails with an actionable error outside a repository', async () => {
    await expect(g.detectRepository(tempDir())).rejects.toMatchObject({
      message: 'Not inside a Git repository.',
      exitCode: 2,
    });
  });
});

describe('branch inspection', () => {
  it('computes ahead/behind and simulates merges without touching the worktree', async () => {
    const { root } = createRepo();
    git(root, 'branch', 'feature');
    commitFile(root, 'shared.txt', 'main version\n');
    git(root, 'checkout', '-q', 'feature');
    commitFile(root, 'shared.txt', 'feature version\n');
    commitFile(root, 'other.txt', 'x\n');
    git(root, 'checkout', '-q', 'main');

    expect(await g.aheadBehind(root, 'main', 'feature')).toEqual({ ahead: 2, behind: 1 });
    expect(await g.changedFiles(root, 'main', 'feature')).toEqual(['other.txt', 'shared.txt']);
    if (await g.supportsMergeTree()) {
      expect(await g.checkMerge(root, 'main', 'feature')).toEqual({ clean: false, conflicts: ['shared.txt'] });
    }
    expect((await g.status(root)).dirty).toBe(false);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('validates branch names and detects the default branch', async () => {
    const { root } = createRepo();
    expect(await g.isValidBranchName(root, 'feat/ok')).toBe(true);
    expect(await g.isValidBranchName(root, 'bad..name')).toBe(false);
    expect(await g.isValidBranchName(root, '-x')).toBe(false);
    expect(await g.detectDefaultBranch(root)).toBe('main');
  });

  it('extracts added lines for secret scanning', async () => {
    const { root } = createRepo();
    git(root, 'checkout', '-q', '-b', 'feature');
    writeFileSync(path.join(root, 'a.txt'), 'hello\nworld\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'a');
    expect(await g.addedLines(root, 'main', 'feature')).toEqual([
      { file: 'a.txt', line: 'hello' },
      { file: 'a.txt', line: 'world' },
    ]);
  });
});
