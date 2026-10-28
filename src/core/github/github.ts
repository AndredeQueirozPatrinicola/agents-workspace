import { AwError, ExitCode } from '../errors.js';
import { type CommandRunner, ensureSuccess } from '../../infrastructure/process/runner.js';
import { findExecutable, parseVersion } from '../../infrastructure/process/shell.js';

/**
 * GitHub integration through the GitHub CLI (`gh`). Authentication is fully
 * delegated to `gh auth login`; Agent Workspace never handles tokens.
 *
 * Argument builders are exported as pure functions so command construction
 * can be unit-tested without invoking `gh`.
 */

export interface PullRequestInfo {
  number: number;
  url: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  title: string;
  headRefName: string;
  baseRefName: string;
}

export interface CheckSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
}

export interface PullRequestStatus extends PullRequestInfo {
  mergeable: string | null;
  reviewDecision: string | null;
  checks: CheckSummary;
}

export const PR_LIST_FIELDS = 'number,url,state,isDraft,title,headRefName,baseRefName';
export const PR_VIEW_FIELDS = `${PR_LIST_FIELDS},mergeable,reviewDecision,statusCheckRollup`;

export function buildPrListArgs(branch: string): string[] {
  return ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', PR_LIST_FIELDS];
}

export function buildPrViewArgs(ref: string | number): string[] {
  return ['pr', 'view', String(ref), '--json', PR_VIEW_FIELDS];
}

export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
  draft: boolean;
}

export function buildPrCreateArgs(input: CreatePrInput): string[] {
  const args = ['pr', 'create', '--base', input.base, '--head', input.head, '--title', input.title, '--body-file', input.bodyFile];
  if (input.draft) args.push('--draft');
  return args;
}

/** Recognize GitHub.com remotes (HTTPS, SSH and ssh:// forms). */
export function isGitHubUrl(url: string): boolean {
  return /^(https?:\/\/([^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(:\d+)?\/)/i.test(url.trim());
}

/** Choose the most relevant PR for a branch: open first, then the most recent. */
export function pickPullRequest(prs: PullRequestInfo[]): PullRequestInfo | null {
  if (prs.length === 0) return null;
  const open = prs.find((p) => p.state === 'OPEN');
  if (open) return open;
  return [...prs].sort((a, b) => b.number - a.number)[0] ?? null;
}

interface RollupItem {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

export function summarizeChecks(rollup: RollupItem[] | null | undefined): CheckSummary {
  const summary: CheckSummary = { total: 0, passing: 0, failing: 0, pending: 0 };
  for (const item of rollup ?? []) {
    summary.total++;
    // CheckRun: status + conclusion. StatusContext: state.
    const conclusion = (item.conclusion ?? item.state ?? '').toUpperCase();
    const status = (item.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') summary.pending++;
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) summary.passing++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(conclusion)) summary.pending++;
    else summary.failing++;
  }
  return summary;
}

export class GitHubClient {
  constructor(private readonly runner: CommandRunner) {}

  async isInstalled(): Promise<boolean> {
    return (await findExecutable('gh')) !== null;
  }

  async version(): Promise<string | null> {
    try {
      const result = await this.runner.run('gh', ['--version']);
      return result.exitCode === 0 ? parseVersion(result.stdout) : null;
    } catch {
      return null;
    }
  }

  async authStatus(cwd: string): Promise<{ ok: boolean; message: string }> {
    const result = await this.runner.run('gh', ['auth', 'status'], { cwd });
    return { ok: result.exitCode === 0, message: (result.stderr || result.stdout).trim() };
  }

  async assertReady(cwd: string): Promise<void> {
    if (!(await this.isInstalled())) {
      throw new AwError('GitHub CLI (gh) is not installed.', {
        exitCode: ExitCode.PREREQUISITE,
        hint: 'Install it from https://cli.github.com/ and run "gh auth login".',
      });
    }
    const auth = await this.authStatus(cwd);
    if (!auth.ok) {
      throw new AwError('GitHub CLI is not authenticated.', {
        exitCode: ExitCode.PREREQUISITE,
        details: auth.message.split('\n').slice(0, 5),
        hint: 'Run "gh auth login".',
      });
    }
  }

  /** Verify that gh can resolve the repository (works for GitHub Enterprise too). */
  async repoName(cwd: string): Promise<string | null> {
    const result = await this.runner.run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  async findPullRequest(cwd: string, branch: string): Promise<PullRequestInfo | null> {
    const result = ensureSuccess(await this.runner.run('gh', buildPrListArgs(branch), { cwd }), 'Listing pull requests');
    const prs = JSON.parse(result.stdout || '[]') as PullRequestInfo[];
    return pickPullRequest(prs.filter((p) => p.headRefName === branch));
  }

  async createPullRequest(cwd: string, input: CreatePrInput): Promise<string> {
    const result = ensureSuccess(await this.runner.run('gh', buildPrCreateArgs(input), { cwd }), 'Creating pull request');
    const url = result.stdout.trim().split('\n').reverse().find((l) => /^https?:\/\//.test(l));
    return url ?? result.stdout.trim();
  }

  async viewPullRequest(cwd: string, ref: string | number): Promise<PullRequestStatus | null> {
    const result = await this.runner.run('gh', buildPrViewArgs(ref), { cwd });
    if (result.exitCode !== 0) return null;
    const data = JSON.parse(result.stdout) as PullRequestInfo & {
      mergeable?: string;
      reviewDecision?: string;
      statusCheckRollup?: RollupItem[];
    };
    return {
      number: data.number,
      url: data.url,
      state: data.state,
      isDraft: data.isDraft,
      title: data.title,
      headRefName: data.headRefName,
      baseRefName: data.baseRefName,
      mergeable: data.mergeable ?? null,
      reviewDecision: data.reviewDecision || null,
      checks: summarizeChecks(data.statusCheckRollup),
    };
  }
}
