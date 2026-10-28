import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import { type CommandRunner, type RunResult, ensureSuccess } from '../../infrastructure/process/runner.js';
import { canonicalPath } from '../../infrastructure/filesystem/fs.js';
import { compareVersions, parseVersion } from '../../infrastructure/process/shell.js';

/**
 * Thin, typed wrapper around the Git CLI.
 *
 * Only non-destructive commands are exposed here, plus the explicitly safe
 * variants of mutating ones (`worktree remove` without --force,
 * `branch -d` instead of `-D`, `push` without --force).
 */

export interface RepoInfo {
  /** Top-level directory of the current working tree (null for bare repos). */
  toplevel: string | null;
  /** Git directory of the current working tree (`.git` or `.git/worktrees/<id>`). */
  gitDir: string;
  /** Common Git directory shared by all worktrees. */
  commonDir: string;
  isBare: boolean;
  /** True when the current working tree is a linked worktree (not the main one). */
  isLinkedWorktree: boolean;
  /** Path of the main working tree, or null for bare repositories. */
  mainWorktree: string | null;
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorkingTreeStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  dirty: boolean;
  files: string[];
}

export interface MergeCheck {
  clean: boolean;
  conflicts: string[];
}

export const MIN_GIT_VERSION = '2.31.0';
export const MERGE_TREE_GIT_VERSION = '2.38.0';

export class Git {
  constructor(private readonly runner: CommandRunner) {}

  run(cwd: string, args: string[]): Promise<RunResult> {
    // core.quotePath=false: report non-ASCII paths verbatim (safety checks match on names).
    return this.runner.run('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  }

  async exec(cwd: string, args: string[], context?: string): Promise<string> {
    const result = ensureSuccess(await this.run(cwd, args), context);
    return result.stdout;
  }

  async version(): Promise<string | null> {
    try {
      const result = await this.runner.run('git', ['--version']);
      return result.exitCode === 0 ? parseVersion(result.stdout) : null;
    } catch {
      return null;
    }
  }

  async supportsMergeTree(): Promise<boolean> {
    const v = await this.version();
    return v !== null && compareVersions(v, MERGE_TREE_GIT_VERSION) >= 0;
  }

  /** Detect the repository containing `cwd`. Throws a helpful error when outside a repo. */
  async detectRepository(cwd: string): Promise<RepoInfo> {
    const probe = await this.run(cwd, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree']);
    if (probe.exitCode !== 0) {
      throw new AwError('Not inside a Git repository.', {
        exitCode: ExitCode.USAGE,
        hint: 'cd into your project directory (or run "git init") and try again.',
      });
    }
    const [bareLine, insideLine] = probe.stdout.trim().split('\n');
    const isBare = bareLine === 'true';
    const inside = insideLine === 'true';
    const dirs = (
      await this.exec(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], 'Resolving Git directories')
    )
      .trim()
      .split('\n');
    const gitDir = canonicalPath(dirs[0] ?? '');
    const commonDir = canonicalPath(dirs[1] ?? '');
    let toplevel: string | null = null;
    if (inside) {
      toplevel = canonicalPath((await this.exec(cwd, ['rev-parse', '--show-toplevel'])).trim());
    }
    const worktrees = await this.listWorktrees(cwd);
    const first = worktrees[0];
    const mainWorktree = first && !first.bare ? first.path : null;
    return {
      toplevel,
      gitDir,
      commonDir,
      isBare,
      isLinkedWorktree: gitDir !== commonDir,
      mainWorktree,
    };
  }

  async listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
    const out = await this.exec(cwd, ['worktree', 'list', '--porcelain'], 'Listing worktrees');
    return parseWorktreeList(out);
  }

  async isValidBranchName(cwd: string, name: string): Promise<boolean> {
    if (name.startsWith('-')) return false;
    return (await this.run(cwd, ['check-ref-format', '--branch', name])).exitCode === 0;
  }

  async refExists(cwd: string, ref: string): Promise<boolean> {
    return (await this.run(cwd, ['show-ref', '--verify', '--quiet', ref])).exitCode === 0;
  }

  branchExists(cwd: string, branch: string): Promise<boolean> {
    return this.refExists(cwd, `refs/heads/${branch}`);
  }

  remoteBranchExists(cwd: string, remote: string, branch: string): Promise<boolean> {
    return this.refExists(cwd, `refs/remotes/${remote}/${branch}`);
  }

  async revParse(cwd: string, ref: string): Promise<string | null> {
    const result = await this.run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async currentBranch(cwd: string): Promise<string | null> {
    const result = await this.run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /** Best-effort detection of the repository's default branch. */
  async detectDefaultBranch(cwd: string, remote = 'origin'): Promise<string> {
    const remoteHead = await this.run(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (remoteHead.exitCode === 0) {
      const value = remoteHead.stdout.trim();
      return value.startsWith(`${remote}/`) ? value.slice(remote.length + 1) : value;
    }
    for (const candidate of ['main', 'master', 'trunk', 'develop']) {
      if (await this.branchExists(cwd, candidate)) return candidate;
    }
    return (await this.currentBranch(cwd)) ?? 'main';
  }

  async gitDirOf(worktreePath: string): Promise<string> {
    return canonicalPath((await this.exec(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim());
  }

  async addWorktree(
    cwd: string,
    worktreePath: string,
    options: { branch: string; createFrom?: string; track?: boolean },
  ): Promise<void> {
    const args = ['worktree', 'add'];
    if (options.createFrom) {
      args.push(options.track ? '--track' : '--no-track', '-b', options.branch, worktreePath, options.createFrom);
    } else {
      args.push(worktreePath, options.branch);
    }
    await this.exec(cwd, args, 'Creating worktree');
  }

  /** Remove a worktree. Never uses --force: Git refuses when it has local changes. */
  async removeWorktree(cwd: string, worktreePath: string): Promise<void> {
    await this.exec(cwd, ['worktree', 'remove', worktreePath], 'Removing worktree');
  }

  async status(worktreePath: string): Promise<WorkingTreeStatus> {
    const out = await this.exec(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'], 'Reading status');
    return parseStatus(out);
  }

  /** Returns [behind, ahead] counts of `branch` relative to `base`. */
  async aheadBehind(cwd: string, base: string, branch: string): Promise<{ ahead: number; behind: number } | null> {
    const result = await this.run(cwd, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
    if (result.exitCode !== 0) return null;
    const [behind, ahead] = result.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  async commitsBetween(cwd: string, base: string, branch: string): Promise<string[]> {
    const result = await this.run(cwd, ['log', '--format=%h %s', `${base}..${branch}`]);
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').filter(Boolean);
  }

  async changedFiles(cwd: string, base: string, branch: string): Promise<string[]> {
    const result = await this.run(cwd, ['diff', '--name-only', `${base}...${branch}`]);
    if (result.exitCode !== 0) return [];
    return result.stdout.split('\n').filter(Boolean);
  }

  /**
   * Ignored files/directories in a worktree (collapsed per directory), which
   * `git status` does not report but `git worktree remove` would delete.
   */
  async ignoredFiles(worktreePath: string): Promise<string[]> {
    const out = await this.exec(worktreePath, ['status', '--porcelain=v1', '--ignored=traditional', '--untracked-files=normal'], 'Reading ignored files');
    return out
      .split('\n')
      .filter((l) => l.startsWith('!! '))
      .map((l) => l.slice(3));
  }

  /** True when HEAD of the worktree is contained in at least one branch or remote-tracking ref. */
  async isHeadReachable(worktreePath: string): Promise<boolean> {
    const result = await this.run(worktreePath, ['for-each-ref', '--count=1', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  }

  /**
   * Files touched by any commit that a push of `branch` would publish
   * (commits not yet on any `<remote>/*` ref), including files that were
   * added and later deleted again.
   */
  async filesInPushRange(cwd: string, branch: string, remote: string): Promise<string[]> {
    const result = await this.run(cwd, ['log', '--no-renames', '--name-only', '--format=', `refs/heads/${branch}`, '--not', `--remotes=${remote}`]);
    if (result.exitCode !== 0) return [];
    return [...new Set(result.stdout.split('\n').map((l) => l.trim()).filter(Boolean))];
  }

  /** Added lines in every commit a push of `branch` would publish. */
  async addedLinesInPushRange(cwd: string, branch: string, remote: string): Promise<Array<{ file: string; line: string }>> {
    const result = await this.run(cwd, [
      'log', '-p', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--format=',
      `refs/heads/${branch}`, '--not', `--remotes=${remote}`,
    ]);
    if (result.exitCode !== 0) return [];
    return parseAddedLines(result.stdout);
  }

  /** Added lines in `base...branch` (used for best-effort secret scanning). */
  async addedLines(cwd: string, base: string, branch: string): Promise<Array<{ file: string; line: string }>> {
    const result = await this.run(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', '--no-color', `${base}...${branch}`]);
    if (result.exitCode !== 0) return [];
    return parseAddedLines(result.stdout);
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return (await this.run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).exitCode === 0;
  }

  /**
   * Non-destructive merge simulation using `git merge-tree --write-tree`
   * (Git >= 2.38). Nothing in any working tree or ref is modified.
   */
  async checkMerge(cwd: string, a: string, b: string): Promise<MergeCheck | null> {
    const result = await this.run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b]);
    if (result.exitCode === 0) return { clean: true, conflicts: [] };
    if (result.exitCode === 1) {
      const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      return { clean: false, conflicts: [...new Set(lines.slice(1))] };
    }
    return null;
  }

  async remoteUrl(cwd: string, remote: string): Promise<string | null> {
    const result = await this.run(cwd, ['remote', 'get-url', remote]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async fetch(cwd: string, remote: string, refs: string[]): Promise<RunResult> {
    return this.run(cwd, ['fetch', '--no-tags', remote, ...refs]);
  }

  /** Push without force. Sets upstream. */
  async push(cwd: string, remote: string, branch: string): Promise<void> {
    await this.exec(cwd, ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], 'Pushing branch');
  }

  /** Safe branch deletion (`-d`): Git refuses to delete unmerged branches. */
  async deleteBranchSafe(cwd: string, branch: string): Promise<RunResult> {
    return this.run(cwd, ['branch', '-d', branch]);
  }

  async isIgnored(cwd: string, p: string): Promise<boolean> {
    return (await this.run(cwd, ['check-ignore', '-q', p])).exitCode === 0;
  }
}

export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: canonicalPath(path.normalize(line.slice('worktree '.length))),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (!current) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function parseAddedLines(diff: string): Array<{ file: string; line: string }> {
  const lines: Array<{ file: string; line: string }> = [];
  let file = '';
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) file = raw.slice(4).replace(/^"?b\//, '').replace(/"$/, '');
    else if (raw.startsWith('+') && !raw.startsWith('+++')) lines.push({ file, line: raw.slice(1) });
  }
  return lines;
}

export function parseStatus(output: string): WorkingTreeStatus {
  const status: WorkingTreeStatus = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, dirty: false, files: [] };
  for (const line of output.split('\n')) {
    if (line.length < 3) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    status.files.push(line.slice(3));
    if (x === '?' && y === '?') {
      status.untracked++;
      continue;
    }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
      status.conflicted++;
      continue;
    }
    if (x !== ' ') status.staged++;
    if (y !== ' ') status.unstaged++;
  }
  status.dirty = status.files.length > 0;
  return status;
}
