import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { AwError, ExitCode } from '../errors.js';
import type { Git, WorkingTreeStatus, WorktreeEntry } from '../git/git.js';
import { WORKTREE_MARKER_FILE } from '../state/runtime-state.js';
import {
  canonicalPath,
  displayPath,
  ensureDir,
  isEmptyDirectory,
  pathExists,
  readTextIfExists,
  samePath,
  writeFileAtomic,
} from '../../infrastructure/filesystem/fs.js';

/**
 * Creates, inspects and removes agent worktrees.
 *
 * Ownership: every worktree created by Agent Workspace gets a marker file in
 * its *Git* directory (`.git/worktrees/<id>/agent-workspace.json`), outside
 * the working tree, so it never shows up in `git status` and is removed by
 * Git together with the worktree. Worktrees without a marker are treated as
 * user-owned and are never modified.
 */

export interface WorktreeMarker {
  tool: 'agent-workspace';
  agent: string;
  project: string;
  branch: string;
  createdAt: string;
}

export interface EnsureWorktreeInput {
  agent: string;
  project: string;
  branch: string;
  /** Base branch name used when the branch does not exist yet. */
  base: string;
  remote: string;
  path: string;
  /**
   * Called when an existing worktree without an ownership marker sits at the
   * target path on the right branch (an interrupted spawn, or a worktree the
   * user created). Return true to adopt it. Without a callback it is refused.
   */
  confirmAdopt?: ((worktreePath: string) => Promise<boolean>) | undefined;
}

export type WorktreeSource = 'existing-worktree' | 'local-branch' | 'remote-branch' | 'new-branch';

export interface EnsureWorktreeResult {
  path: string;
  source: WorktreeSource;
  /** Ref the new branch was created from (only for `new-branch`). */
  createdFrom: string | null;
  /** True when an existing worktree without a marker was adopted (interrupted spawn). */
  adopted: boolean;
}

export interface RemoveOptions {
  /** Branch the worktree is expected to be on (defaults to the marker's branch). */
  branch?: string | undefined;
  /** Allow deleting ignored files that are not known build/dependency artifacts. */
  discardIgnored?: boolean | undefined;
}

export interface ManagedWorktree {
  entry: WorktreeEntry;
  marker: WorktreeMarker | null;
}

export class WorktreeManager {
  constructor(
    private readonly git: Git,
    private readonly repoCwd: string,
  ) {}

  async list(): Promise<ManagedWorktree[]> {
    const entries = await this.git.listWorktrees(this.repoCwd);
    const result: ManagedWorktree[] = [];
    for (const entry of entries) {
      result.push({ entry, marker: entry.bare ? null : await this.readMarker(entry.path) });
    }
    return result;
  }

  async findByPath(p: string): Promise<WorktreeEntry | undefined> {
    const entries = await this.git.listWorktrees(this.repoCwd);
    return entries.find((e) => samePath(e.path, p));
  }

  async findByBranch(branch: string): Promise<WorktreeEntry | undefined> {
    const entries = await this.git.listWorktrees(this.repoCwd);
    return entries.find((e) => e.branch === branch);
  }

  async readMarker(worktreePath: string): Promise<WorktreeMarker | null> {
    if (!(await pathExists(worktreePath))) return null;
    try {
      const gitDir = await this.git.gitDirOf(worktreePath);
      const text = await readTextIfExists(path.join(gitDir, WORKTREE_MARKER_FILE));
      if (!text) return null;
      const parsed = JSON.parse(text) as Partial<WorktreeMarker>;
      return parsed.tool === 'agent-workspace' && typeof parsed.agent === 'string' ? (parsed as WorktreeMarker) : null;
    } catch {
      return null;
    }
  }

  async writeMarker(worktreePath: string, marker: WorktreeMarker): Promise<void> {
    const gitDir = await this.git.gitDirOf(worktreePath);
    await writeFileAtomic(path.join(gitDir, WORKTREE_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
  }

  /**
   * Make sure the agent's worktree exists and is checked out on its branch.
   * Idempotent: an existing worktree for the same agent and branch is reused.
   * Never overwrites unrelated directories, worktrees or branches.
   */
  async ensure(input: EnsureWorktreeInput): Promise<EnsureWorktreeResult> {
    const target = canonicalPath(input.path);
    if (!(await this.git.isValidBranchName(this.repoCwd, input.branch))) {
      throw new AwError(`"${input.branch}" is not a valid Git branch name.`, { exitCode: ExitCode.USAGE });
    }
    const entries = await this.git.listWorktrees(this.repoCwd);
    const atPath = entries.find((e) => samePath(e.path, target));
    const marker = (): WorktreeMarker => ({
      tool: 'agent-workspace',
      agent: input.agent,
      project: input.project,
      branch: input.branch,
      createdAt: new Date().toISOString(),
    });

    if (atPath) {
      if (atPath.branch !== input.branch) {
        throw new AwError(
          `A worktree already exists at ${displayPath(target)} on ${atPath.branch ? `branch "${atPath.branch}"` : 'a detached HEAD'}, but agent "${input.agent}" expects branch "${input.branch}".`,
          { exitCode: ExitCode.UNSAFE, hint: 'Check out the expected branch in that worktree, or clean it up first.' },
        );
      }
      if (!(await pathExists(target))) {
        throw new AwError(`Worktree ${displayPath(target)} is registered with Git but its directory is missing.`, {
          exitCode: ExitCode.UNSAFE,
          hint: 'Run "aw repair" to prune stale worktree metadata, then spawn again.',
        });
      }
      const existingMarker = await this.readMarker(target);
      if (existingMarker && existingMarker.agent !== input.agent) {
        throw new AwError(`Worktree ${displayPath(target)} belongs to agent "${existingMarker.agent}".`, {
          exitCode: ExitCode.UNSAFE,
        });
      }
      if (!existingMarker) {
        if (!input.confirmAdopt || !(await input.confirmAdopt(target))) {
          throw new AwError(`${displayPath(target)} is an existing worktree that was not created by Agent Workspace.`, {
            exitCode: ExitCode.UNSAFE,
            hint: 'Re-run with --yes to adopt it for this agent (it can then be cleaned up by aw), or remove/move it yourself.',
          });
        }
        await this.writeMarker(target, marker());
      }
      return { path: target, source: 'existing-worktree', createdFrom: null, adopted: !existingMarker };
    }

    const elsewhere = entries.find((e) => e.branch === input.branch);
    if (elsewhere) {
      throw new AwError(`Branch "${input.branch}" is already checked out at ${displayPath(elsewhere.path)}.`, {
        exitCode: ExitCode.UNSAFE,
        hint: 'Git allows a branch in only one worktree. Use a different branch (--branch) or switch that worktree to another branch.',
      });
    }

    if (await pathExists(target)) {
      if (!(await isEmptyDirectory(target))) {
        throw new AwError(`${displayPath(target)} already exists and is not a Git worktree. Refusing to overwrite it.`, {
          exitCode: ExitCode.UNSAFE,
          hint: 'Move or delete that directory yourself, or configure a different workspace.directory.',
        });
      }
    }

    await ensureDir(path.dirname(target));
    let source: WorktreeSource;
    let createdFrom: string | null = null;
    if (await this.git.branchExists(this.repoCwd, input.branch)) {
      await this.git.addWorktree(this.repoCwd, target, { branch: input.branch });
      source = 'local-branch';
    } else if (await this.git.remoteBranchExists(this.repoCwd, input.remote, input.branch)) {
      // Recreating an environment on another machine: continue from the pushed branch.
      createdFrom = `${input.remote}/${input.branch}`;
      await this.git.addWorktree(this.repoCwd, target, { branch: input.branch, createFrom: createdFrom, track: true });
      source = 'remote-branch';
    } else {
      createdFrom = await this.resolveBaseRef(input.base, input.remote);
      await this.git.addWorktree(this.repoCwd, target, { branch: input.branch, createFrom: createdFrom, track: false });
      source = 'new-branch';
    }
    await this.writeMarker(target, marker());
    return { path: target, source, createdFrom, adopted: false };
  }

  /** Prefer the local base branch; fall back to the remote-tracking branch. */
  async resolveBaseRef(base: string, remote: string): Promise<string> {
    if (await this.git.branchExists(this.repoCwd, base)) return base;
    if (await this.git.remoteBranchExists(this.repoCwd, remote, base)) return `${remote}/${base}`;
    if (await this.git.revParse(this.repoCwd, base)) return base; // tag or commit
    if (!(await this.git.hasCommits(this.repoCwd))) {
      throw new AwError('The repository has no commits yet, so there is nothing to branch agent worktrees from.', {
        exitCode: ExitCode.USAGE,
        hint: 'Create an initial commit first, e.g.: git add .agents && git commit -m "Add Agent Workspace configuration"',
      });
    }
    const hasRemote = await this.git.remoteExists(this.repoCwd, remote);
    throw new AwError(`Base branch "${base}" was not found locally${hasRemote ? ` or on "${remote}"` : ''}.`, {
      exitCode: ExitCode.USAGE,
      hint: hasRemote
        ? `Create it, run "git fetch ${remote}", or set project.baseBranch in .agents/workspace.yaml.`
        : `Create it (e.g. "git branch ${base}") or set project.baseBranch in .agents/workspace.yaml to an existing branch.`,
    });
  }

  async status(worktreePath: string): Promise<WorkingTreeStatus | null> {
    if (!(await pathExists(worktreePath))) return null;
    try {
      return await this.git.status(worktreePath);
    } catch {
      return null;
    }
  }

  /**
   * Remove a managed worktree. Refuses when:
   *  - the worktree has no Agent Workspace marker (user-owned),
   *  - it has uncommitted or untracked changes,
   *  - it is locked.
   * The branch and its commits are never touched here.
   */
  async remove(worktreePath: string, agent: string, options: RemoveOptions = {}): Promise<void> {
    await this.assertRemovable(worktreePath, agent, options);
    await this.git.removeWorktree(this.repoCwd, worktreePath);
    // Remove now-empty parent directory (the project's workspace dir) if possible.
    await fsp.rmdir(path.dirname(worktreePath)).catch(() => undefined);
  }

  /** Throw an explanatory AwError if removing this worktree could lose anything. */
  async assertRemovable(worktreePath: string, agent: string, options: RemoveOptions = {}): Promise<void> {
    const entry = await this.findByPath(worktreePath);
    if (!entry) {
      throw new AwError(`${displayPath(worktreePath)} is not a registered worktree.`, { exitCode: ExitCode.UNSAFE });
    }
    const marker = await this.readMarker(worktreePath);
    if (!marker || marker.agent !== agent) {
      throw new AwError(`${displayPath(worktreePath)} is not managed by Agent Workspace for agent "${agent}". Refusing to remove it.`, {
        exitCode: ExitCode.UNSAFE,
      });
    }
    if (entry.locked) {
      throw new AwError(`Worktree ${displayPath(worktreePath)} is locked.`, {
        exitCode: ExitCode.UNSAFE,
        hint: `Unlock it with "git worktree unlock ${worktreePath}" if you are sure it is no longer in use.`,
      });
    }
    const status = await this.git.status(worktreePath);
    if (status.dirty) {
      throw new AwError(`Worktree for "${agent}" has uncommitted changes; refusing to remove it.`, {
        exitCode: ExitCode.UNSAFE,
        details: status.files.slice(0, 15),
        hint: 'Commit, stash or discard the changes yourself, then run cleanup again.',
      });
    }
    // Commits made on a detached HEAD or another branch would only be referenced
    // by this worktree's reflog, which is deleted together with the worktree.
    const expectedBranch = options.branch ?? marker.branch;
    if (entry.branch !== expectedBranch && !(await this.git.isHeadReachable(worktreePath))) {
      throw new AwError(
        `Worktree for "${agent}" is ${entry.branch ? `on branch "${entry.branch}"` : 'on a detached HEAD'} with commits not contained in any branch; refusing to remove it.`,
        {
          exitCode: ExitCode.UNSAFE,
          hint: `Save the work first, e.g. "git -C ${worktreePath} switch -c <new-branch>" or switch back to "${expectedBranch}".`,
        },
      );
    }
    const ignored = (await this.git.ignoredFiles(worktreePath)).filter((f) => !isRegenerable(f));
    if (ignored.length && !options.discardIgnored) {
      throw new AwError(`Worktree for "${agent}" contains ignored files that would be deleted; refusing to remove it.`, {
        exitCode: ExitCode.UNSAFE,
        details: ignored.slice(0, 15),
        hint: 'Move anything you need (e.g. .env, local databases) out of the worktree, or re-run with --discard-ignored.',
      });
    }
  }
}

/**
 * Ignored paths that are safe to delete because tools regenerate them
 * (dependency installs, build output, caches).
 */
const REGENERABLE = /(^|\/)(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|\.vite|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|\.gradle|\.tox)\/?$|\.(pyc|log|tsbuildinfo)$|(^|\/)\.DS_Store$/;

export function isRegenerable(file: string): boolean {
  return REGENERABLE.test(file.replace(/\\/g, '/'));
}
