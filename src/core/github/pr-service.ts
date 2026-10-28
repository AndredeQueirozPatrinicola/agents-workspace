import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import { resolveAgent, validateAgentName } from '../config/loader.js';
import { loadTask } from '../tasks/task.js';
import type { Workspace } from '../workspace/workspace.js';
import type { AgentService } from '../agents/service.js';
import { isSensitivePath, scanForSecrets } from '../safety/safety.js';
import { type PullRequestStatus, isGitHubUrl } from './github.js';
import { confirmOrAbort } from '../../infrastructure/terminal/prompt.js';

/**
 * Pull requests as deliberate integration checkpoints.
 *
 * `aw pr <agent>` never commits, never force-pushes and never merges. It
 * verifies the branch, refuses to publish obvious secrets, asks before
 * pushing, and avoids duplicate PRs.
 */

export interface CreatePrOptions {
  draft?: boolean | undefined;
  title?: string | undefined;
  bodyFile?: string | undefined;
  yes?: boolean | undefined;
  allowSensitive?: boolean | undefined;
}

export interface PrStatusRow {
  agent: string;
  branch: string;
  pr: PullRequestStatus | null;
  error: string | null;
}

export class PrService {
  constructor(
    private readonly deps: Deps,
    private readonly agents: AgentService,
  ) {}

  private async assertGitHubRemote(ws: Workspace, cwd: string): Promise<void> {
    const remote = ws.config.project.remote;
    const url = await this.deps.git.remoteUrl(cwd, remote);
    if (!url) {
      throw new AwError(`The repository has no "${remote}" remote.`, {
        exitCode: ExitCode.PREREQUISITE,
        hint: `Add one with "git remote add ${remote} <github-url>" or set project.remote in workspace.yaml.`,
      });
    }
    if (!isGitHubUrl(url) && !(await this.deps.github.repoName(cwd))) {
      throw new AwError(`Remote "${remote}" (${url}) is not a GitHub repository that gh can access.`, {
        exitCode: ExitCode.PREREQUISITE,
        hint: 'For GitHub Enterprise, authenticate with "gh auth login --hostname <host>".',
      });
    }
  }

  async create(name: string, options: CreatePrOptions = {}): Promise<{ url: string; created: boolean }> {
    validateAgentName(name);
    const ws = await this.agents.open();
    const record = await ws.state.getAgent(name);
    if (!record && !ws.config.agents[name]) {
      throw new AwError(`Unknown agent "${name}".`, { exitCode: ExitCode.USAGE, hint: 'Run "aw status" to list agents.' });
    }
    const agent = resolveAgent(ws.config, name, record ? { branch: record.branch, base: record.base } : {});
    const draft = options.draft ?? ws.config.defaults.createDraftPR;
    const task = await loadTask(ws.configRoot, agent.task, ws.taskRoots).catch(() => null);
    return this.publishBranch(ws, {
      label: name,
      branch: agent.branch,
      base: agent.base,
      worktree: record?.worktreePath ?? null,
      title: options.title ?? (task?.title && !task.isTemplate ? task.title : `${name}: ${agent.branch}`),
      bodyFile: options.bodyFile ? path.resolve(this.deps.cwd, options.bodyFile) : null,
      body: (commits) => buildPrBody({ agent: name, provider: agent.provider, task: task && !task.isTemplate ? task : null, commits }),
      draft,
      yes: options.yes,
      allowSensitive: options.allowSensitive,
      notFoundHint: `Spawn the agent first: aw spawn ${name}`,
      record: (pr) => this.recordPr(ws, name, pr),
    });
  }

  /**
   * Push a branch and open (or reuse) its pull request, after the safety
   * checks. Shared by agent PRs and feature PRs.
   */
  async publishBranch(
    ws: Workspace,
    p: {
      label: string;
      branch: string;
      base: string;
      worktree: string | null;
      title: string;
      bodyFile: string | null;
      body: (commits: string[]) => string;
      draft: boolean;
      yes?: boolean | undefined;
      allowSensitive?: boolean | undefined;
      notFoundHint?: string;
      record: (pr: { number: number; url: string; state: string; isDraft?: boolean }) => Promise<void>;
    },
  ): Promise<{ url: string; created: boolean }> {
    const { ui, git, github } = this.deps;
    const cwd = this.agents.repoCwd(ws);
    const remote = ws.config.project.remote;
    const options = { yes: p.yes, allowSensitive: p.allowSensitive };

    ui.header(`Pull request: ${p.label}`);
    await github.assertReady(cwd);
    await this.assertGitHubRemote(ws, cwd);
    ui.ok('GitHub CLI authenticated');

    if (!(await git.branchExists(cwd, p.branch))) {
      throw new AwError(`Branch "${p.branch}" does not exist locally.`, {
        exitCode: ExitCode.USAGE,
        ...(p.notFoundHint ? { hint: p.notFoundHint } : {}),
      });
    }
    ui.ok(`Branch ${p.branch}`);

    if (p.worktree) {
      const status = await git.status(p.worktree).catch(() => null);
      if (status?.dirty) {
        ui.warn(
          `The worktree has ${status.files.length} uncommitted change(s); they will NOT be part of the PR. Commit them first if they should be.`,
        );
      }
    }

    const base = await this.agents.comparisonBase(ws, p.base);
    if (!base) throw new AwError(`Base branch "${p.base}" not found.`, { exitCode: ExitCode.USAGE });
    const commits = await git.commitsBetween(cwd, base, p.branch);
    if (commits.length === 0) {
      throw new AwError(`No commits on ${p.branch} that are not already in ${base}; nothing to publish.`, {
        exitCode: ExitCode.USAGE,
        hint: 'Ask the agent to commit its work (Agent Workspace never commits on its behalf).',
      });
    }
    ui.ok(`${commits.length} commit(s) ahead of ${base}`);

    // Safety: never publish obvious secrets or local runtime files. Scan every
    // commit the push would publish (not just the net diff): a secret added in
    // one commit and deleted in the next is still in the pushed history.
    const files = await git.filesInPushRange(cwd, p.branch, remote);
    const sensitive = files.filter(isSensitivePath);
    const secrets = scanForSecrets(await git.addedLinesInPushRange(cwd, p.branch, remote));
    if (sensitive.length || secrets.length) {
      const details = [
        ...sensitive.map((f) => `sensitive file: ${f}`),
        ...secrets.map((s) => `possible ${s.kind} in ${s.file}`),
      ];
      if (!options.allowSensitive) {
        throw new AwError('Refusing to publish: the branch appears to contain secrets or local-only files.', {
          exitCode: ExitCode.UNSAFE,
          details,
          hint: 'Remove them from the branch history, or re-run with --allow-sensitive if these are false positives.',
        });
      }
      for (const d of details) ui.warn(d);
      await confirmOrAbort(this.deps.prompter, 'Publish anyway?', { assumeYes: options.yes });
    }

    // Existing PR?
    const existing = await github.findPullRequest(cwd, p.branch);
    if (existing && existing.state === 'OPEN') {
      await this.pushIfNeeded(cwd, remote, p.branch, options.yes);
      await p.record(existing);
      ui.ok(`Pull request already exists: #${existing.number}${existing.isDraft ? ' (draft)' : ''}`);
      ui.line();
      ui.line(existing.url);
      return { url: existing.url, created: false };
    }
    if (existing) ui.info(`Previous PR #${existing.number} is ${existing.state.toLowerCase()}; creating a new one.`);

    await this.pushIfNeeded(cwd, remote, p.branch, options.yes);

    let bodyFile = p.bodyFile;
    let tmpDir: string | null = null;
    if (!bodyFile) {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-pr-'));
      bodyFile = path.join(tmpDir, 'body.md');
      await fsp.writeFile(bodyFile, p.body(commits), 'utf8');
    }
    try {
      const url = await github.createPullRequest(cwd, { base: p.base, head: p.branch, title: p.title, bodyFile, draft: p.draft });
      ui.ok(`Pull request created${p.draft ? ' (draft)' : ''}`);
      const created = await github.findPullRequest(cwd, p.branch).catch(() => null);
      if (created) await p.record(created);
      ui.line();
      ui.line(url);
      return { url, created: true };
    } finally {
      if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  private async pushIfNeeded(cwd: string, remote: string, branch: string, yes?: boolean): Promise<void> {
    const { git, ui } = this.deps;
    const local = await git.revParse(cwd, branch);
    const remoteExists = await git.remoteBranchExists(cwd, remote, branch);
    if (remoteExists) {
      const counts = await git.aheadBehind(cwd, `${remote}/${branch}`, branch);
      if (counts && counts.ahead === 0 && counts.behind === 0) {
        ui.ok(`Branch is up to date on ${remote}`);
        return;
      }
      if (counts && counts.behind > 0) {
        throw new AwError(`${branch} has diverged from ${remote}/${branch} (${counts.behind} remote commit(s) not in the local branch).`, {
          exitCode: ExitCode.UNSAFE,
          hint: `Integrate the remote changes yourself (e.g. "git -C <worktree> pull --no-rebase"). Agent Workspace never force-pushes.`,
        });
      }
    }
    await confirmOrAbort(this.deps.prompter, `Push ${branch} (${local?.slice(0, 7) ?? '?'}) to ${remote}?`, {
      assumeYes: yes,
      defaultYes: true,
    });
    await git.push(cwd, remote, branch);
    ui.ok(`Pushed ${branch} to ${remote}`);
  }

  private async recordPr(
    ws: Workspace,
    name: string,
    pr: { number: number; url: string; state: string; isDraft?: boolean },
  ): Promise<void> {
    await ws.state.recordPr(name, {
      number: pr.number,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft ?? false,
      updatedAt: new Date().toISOString(),
    });
  }

  async status(): Promise<PrStatusRow[]> {
    const { github } = this.deps;
    const ws = await this.agents.open();
    const cwd = this.agents.repoCwd(ws);
    await github.assertReady(cwd);
    const state = await ws.state.load();
    const names = [...new Set([...Object.keys(ws.config.agents), ...Object.keys(state.agents)])];
    const rows: PrStatusRow[] = [];
    // Note: records PR state even for agents without a worktree (cleaned up or never spawned here).
    for (const name of names) {
      const record = state.agents[name];
      const branch = record?.branch ?? resolveAgent(ws.config, name).branch;
      try {
        const found = await github.findPullRequest(cwd, branch);
        const pr = found ? await github.viewPullRequest(cwd, found.number) : null;
        if (pr) await this.recordPr(ws, name, pr);
        rows.push({ agent: name, branch, pr, error: null });
      } catch (error) {
        rows.push({ agent: name, branch, pr: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return rows;
  }
}

export function buildPrBody(input: {
  agent: string;
  provider: string;
  task: { relativePath: string; sections: Record<string, string>; title: string | null } | null;
  commits: string[];
}): string {
  const parts: string[] = [];
  const objective = input.task?.sections.Objective;
  if (objective) parts.push('## Summary', '', objective, '');
  const criteria = input.task?.sections['Acceptance Criteria'];
  if (criteria) parts.push('## Acceptance criteria', '', criteria, '');
  parts.push('## Commits', '', ...input.commits.map((c) => `- ${c}`), '');
  parts.push(
    '---',
    `Prepared by the \`${input.agent}\` agent (${input.provider}) with Agent Workspace.` +
      (input.task ? ` Task: \`${input.task.relativePath}\`.` : ''),
    '',
    'Review carefully: parallel agents may have made logically conflicting changes on other branches.',
  );
  return parts.join('\n');
}
