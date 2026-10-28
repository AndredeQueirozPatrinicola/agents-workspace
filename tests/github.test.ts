import { describe, expect, it } from 'vitest';
import {
  GitHubClient,
  buildPrCreateArgs,
  buildPrListArgs,
  buildPrViewArgs,
  isGitHubUrl,
  pickPullRequest,
  summarizeChecks,
} from '../src/core/github/github.js';
import { buildPrBody } from '../src/core/github/pr-service.js';
import { MockRunner } from './helpers.js';

describe('gh command construction', () => {
  it('builds pr create arguments', () => {
    expect(buildPrCreateArgs({ base: 'main', head: 'agent/api', title: 'API; rm -rf /', bodyFile: '/tmp/b.md', draft: true })).toEqual([
      'pr', 'create', '--base', 'main', '--head', 'agent/api', '--title', 'API; rm -rf /', '--body-file', '/tmp/b.md', '--draft',
    ]);
    expect(buildPrCreateArgs({ base: 'main', head: 'x', title: 't', bodyFile: 'b', draft: false })).not.toContain('--draft');
  });

  it('builds pr list/view arguments with JSON fields', () => {
    expect(buildPrListArgs('agent/api')).toEqual([
      'pr', 'list', '--head', 'agent/api', '--state', 'all', '--limit', '20', '--json', 'number,url,state,isDraft,title,headRefName,baseRefName',
    ]);
    expect(buildPrViewArgs(12).slice(0, 3)).toEqual(['pr', 'view', '12']);
    expect(buildPrViewArgs(12).at(-1)).toContain('statusCheckRollup');
  });
});

describe('GitHub helpers', () => {
  it('recognizes GitHub remotes', () => {
    expect(isGitHubUrl('https://github.com/acme/app.git')).toBe(true);
    expect(isGitHubUrl('git@github.com:acme/app.git')).toBe(true);
    expect(isGitHubUrl('ssh://git@github.com/acme/app.git')).toBe(true);
    expect(isGitHubUrl('https://gitlab.com/acme/app.git')).toBe(false);
    expect(isGitHubUrl('/tmp/origin.git')).toBe(false);
  });

  it('prefers open PRs, then the most recent', () => {
    const pr = (number: number, state: string) => ({ number, state, url: `u${number}`, isDraft: false, title: '', headRefName: 'b', baseRefName: 'main' });
    expect(pickPullRequest([])).toBeNull();
    expect(pickPullRequest([pr(1, 'CLOSED'), pr(3, 'MERGED'), pr(2, 'OPEN')])?.number).toBe(2);
    expect(pickPullRequest([pr(1, 'CLOSED'), pr(3, 'MERGED')])?.number).toBe(3);
  });

  it('summarizes check runs and status contexts', () => {
    expect(
      summarizeChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'PENDING' },
      ]),
    ).toEqual({ total: 5, passing: 2, failing: 1, pending: 2 });
    expect(summarizeChecks(null).total).toBe(0);
  });

  it('builds a PR body from the task and commits', () => {
    const body = buildPrBody({
      agent: 'auth',
      provider: 'claude',
      task: { relativePath: '.agents/tasks/auth.md', title: 'Auth', sections: { Objective: 'JWT auth', 'Acceptance Criteria': '- tests pass' } },
      commits: ['abc123 add login'],
    });
    expect(body).toContain('## Summary\n\nJWT auth');
    expect(body).toContain('- tests pass');
    expect(body).toContain('- abc123 add login');
    expect(body).toContain('`.agents/tasks/auth.md`');
  });
});

describe('GitHubClient', () => {
  it('parses created PR URLs and filters PR lists by head branch', async () => {
    const runner = new MockRunner((_cmd, args) => {
      if (args[1] === 'create') return { stdout: 'Creating pull request...\nhttps://github.com/acme/app/pull/7\n' };
      if (args[1] === 'list') {
        return {
          stdout: JSON.stringify([
            { number: 5, state: 'OPEN', url: 'u5', isDraft: true, title: 't', headRefName: 'agent/api-v2', baseRefName: 'main' },
            { number: 4, state: 'CLOSED', url: 'u4', isDraft: false, title: 't', headRefName: 'agent/api', baseRefName: 'main' },
          ]),
        };
      }
      return {};
    });
    const gh = new GitHubClient(runner);
    expect(await gh.createPullRequest('/repo', { base: 'main', head: 'agent/api', title: 't', bodyFile: 'b', draft: true })).toBe(
      'https://github.com/acme/app/pull/7',
    );
    expect((await gh.findPullRequest('/repo', 'agent/api'))?.number).toBe(4);
    expect(runner.calls.every((c) => c.command === 'gh' && c.options?.cwd === '/repo')).toBe(true);
  });

  it('reports authentication status and surfaces gh failures', async () => {
    const gh = new GitHubClient(new MockRunner(() => ({ exitCode: 1, stderr: 'You are not logged into any GitHub hosts.' })));
    expect(await gh.authStatus('/repo')).toEqual({ ok: false, message: 'You are not logged into any GitHub hosts.' });
    await expect(gh.findPullRequest('/repo', 'x')).rejects.toThrow(/Listing pull requests: command failed/);
    expect(await gh.viewPullRequest('/repo', 1)).toBeNull();
  });
});
