import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.js';
import type { CreatePrInput, GitHubClient, PullRequestInfo, PullRequestStatus } from '../src/core/github/github.js';
import type { Prompter } from '../src/infrastructure/terminal/prompt.js';
import { addBareRemote, type CapturedUi, ScriptedPrompter, captureUi, commitFile, createRepo, git } from './helpers.js';

/**
 * `aw pr` against a real repository and a real (bare, local) remote, with a
 * fake GitHub client standing in for `gh`.
 */

class FakeGitHub {
  prs: PullRequestInfo[] = [];
  created: Array<CreatePrInput & { body: string }> = [];
  ready = true;

  async assertReady(): Promise<void> {
    if (!this.ready) throw Object.assign(new Error('GitHub CLI is not authenticated.'), {});
  }
  async repoName(): Promise<string> {
    return 'acme/my-saas';
  }
  async findPullRequest(_cwd: string, branch: string): Promise<PullRequestInfo | null> {
    return [...this.prs].reverse().find((p) => p.headRefName === branch) ?? null;
  }
  async createPullRequest(_cwd: string, input: CreatePrInput): Promise<string> {
    this.created.push({ ...input, body: readFileSync(input.bodyFile, 'utf8') });
    const number = this.prs.length + 1;
    const url = `https://github.com/acme/my-saas/pull/${number}`;
    this.prs.push({ number, url, state: 'OPEN', isDraft: input.draft, title: input.title, headRefName: input.head, baseRefName: input.base });
    return url;
  }
  async viewPullRequest(_cwd: string, ref: number): Promise<PullRequestStatus | null> {
    const pr = this.prs.find((p) => p.number === ref);
    return pr ? { ...pr, mergeable: 'MERGEABLE', reviewDecision: null, checks: { total: 2, passing: 1, failing: 0, pending: 1 } } : null;
  }
}

let root: string;
let ui: CapturedUi;
let gh: FakeGitHub;

async function aw(args: string[], prompter: Prompter = new ScriptedPrompter(true)): Promise<number> {
  ui = captureUi();
  return runCli(['node', 'aw', ...args], { cwd: root, ui, prompter, github: gh as unknown as GitHubClient, env: { ...process.env } });
}

beforeEach(async () => {
  ({ root } = createRepo('my-saas'));
  addBareRemote(root);
  gh = new FakeGitHub();
  expect(await aw(['init', '--provider', 'codex'])).toBe(0);
  writeFileSync(
    path.join(root, '.agents', 'tasks', 'api.md'),
    '# Task: Users API\n\n## Objective\n\nCRUD endpoints for users.\n\n## Acceptance Criteria\n\n- Tests pass\n',
  );
  const yaml = readFileSync(path.join(root, '.agents', 'workspace.yaml'), 'utf8').replace('agents: {}', 'agents:\n  api:\n    branch: feat/api\n    task: tasks/api.md');
  writeFileSync(path.join(root, '.agents', 'workspace.yaml'), yaml);
  git(root, 'branch', 'feat/api');
});

describe('aw pr', () => {
  it('refuses to open a PR without commits', async () => {
    expect(await aw(['pr', 'api'])).toBe(2);
    expect(ui.text()).toMatch(/nothing to publish/);
    expect(gh.created).toHaveLength(0);
  });

  it('pushes after confirmation and creates a draft PR from the task', async () => {
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'src/api.ts', 'export {};\n', 'Add users API');
    git(root, 'checkout', '-q', 'main');

    const prompter = new ScriptedPrompter(true);
    expect(await aw(['pr', 'api'], prompter)).toBe(0);
    expect(prompter.questions.join()).toMatch(/Push feat\/api/);
    expect(git(root, 'rev-parse', 'origin/feat/api').trim()).toBe(git(root, 'rev-parse', 'feat/api').trim());
    expect(gh.created).toHaveLength(1);
    expect(gh.created[0]).toMatchObject({ base: 'main', head: 'feat/api', title: 'Users API', draft: true });
    expect(gh.created[0]?.body).toContain('CRUD endpoints for users.');
    expect(gh.created[0]?.body).toMatch(/- [0-9a-f]+ Add users API/);
    expect(ui.text()).toContain('https://github.com/acme/my-saas/pull/1');

    // Running again does not create a duplicate.
    expect(await aw(['pr', 'api', '--no-draft'])).toBe(0);
    expect(gh.created).toHaveLength(1);
    expect(ui.text()).toMatch(/already exists: #1 \(draft\)/);

    // PR status lists checks.
    expect(await aw(['pr', 'status', '--json'])).toBe(0);
    const rows = JSON.parse(ui.out.join('\n')) as Array<{ agent: string; pr: { number: number; checks: { total: number } } | null }>;
    expect(rows[0]).toMatchObject({ agent: 'api', pr: { number: 1, checks: { total: 2 } } });
  });

  it('does not push when the user declines', async () => {
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'src/api.ts', 'export {};\n');
    git(root, 'checkout', '-q', 'main');
    expect(await aw(['pr', 'api'], new ScriptedPrompter(false))).toBe(130);
    expect(() => git(root, 'rev-parse', '--verify', '-q', 'origin/feat/api')).toThrow();
    expect(gh.created).toHaveLength(0);
  });

  it('refuses to publish secrets or local-only files unless explicitly allowed', async () => {
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, '.env', 'DATABASE_URL=postgres://user:pass@db/app\n');
    commitFile(root, 'src/key.ts', 'export const k = "AKIAABCDEFGHIJKLMNOP";\n');
    git(root, 'checkout', '-q', 'main');
    expect(await aw(['pr', 'api', '--yes'])).toBe(4);
    expect(ui.text()).toMatch(/sensitive file: \.env/);
    expect(ui.text()).toMatch(/possible AWS access key id in src\/key\.ts/);
    expect(() => git(root, 'rev-parse', '--verify', '-q', 'origin/feat/api')).toThrow();

    expect(await aw(['pr', 'api', '--yes', '--allow-sensitive'])).toBe(0);
    expect(gh.created).toHaveLength(1);
  });

  it('scans the whole pushed history, not just the net diff', async () => {
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'config/ü/.env', 'TOKEN=AKIAABCDEFGHIJKLMNOP\n', 'add env');
    git(root, 'rm', '-q', 'config/ü/.env');
    git(root, 'commit', '-q', '-m', 'remove env');
    commitFile(root, 'src/ok.ts', 'export {};\n');
    git(root, 'checkout', '-q', 'main');
    expect(git(root, 'diff', '--name-only', 'main...feat/api').trim()).toBe('src/ok.ts'); // net diff looks clean
    expect(await aw(['pr', 'api', '--yes'])).toBe(4);
    expect(ui.text()).toMatch(/sensitive file: config\/ü\/\.env/);
    expect(ui.text()).toMatch(/possible AWS access key id in config\/ü\/\.env/);
    expect(() => git(root, 'rev-parse', '--verify', '-q', 'origin/feat/api')).toThrow();
  });

  it('never force-pushes over a diverged remote branch', async () => {
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'a.txt', 'a\n');
    git(root, 'push', '-q', 'origin', 'feat/api');
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    commitFile(root, 'b.txt', 'b\n');
    git(root, 'checkout', '-q', 'main');
    expect(await aw(['pr', 'api', '--yes'])).toBe(4);
    expect(ui.text()).toMatch(/has diverged/);
    expect(gh.created).toHaveLength(0);
  });

  it('requires a remote', async () => {
    git(root, 'remote', 'remove', 'origin');
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'a.txt', 'a\n');
    git(root, 'checkout', '-q', 'main');
    expect(await aw(['pr', 'api'])).toBe(3);
    expect(ui.text()).toMatch(/no "origin" remote/);
  });

  it('caches merged PRs so dependants see the dependency as merged, even without a worktree', async () => {
    const file = path.join(root, '.agents', 'workspace.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('    task: tasks/api.md', '    task: tasks/api.md\n  web:\n    dependsOn: [api]'));
    git(root, 'checkout', '-q', 'feat/api');
    commitFile(root, 'src/api.ts', 'export {};\n');
    git(root, 'checkout', '-q', 'main');
    expect(await aw(['pr', 'api', '--yes'])).toBe(0);
    const deps = async () => {
      expect(await aw(['status', '--json'])).toBe(0);
      const status = JSON.parse(ui.out.join('\n')) as { agents: Array<{ name: string; dependsOn: Array<{ name: string; state: string }> }> };
      return status.agents.find((a) => a.name === 'web')?.dependsOn;
    };
    expect(await deps()).toEqual([{ name: 'api', state: 'pr-open' }]);
    for (const pr of gh.prs) pr.state = 'MERGED';
    expect(await aw(['pr', 'status'])).toBe(0);
    expect(ui.text()).toMatch(/#1 merged/);
    expect(await deps()).toEqual([{ name: 'api', state: 'merged' }]);
  });

  it('rejects unknown agents', async () => {
    expect(await aw(['pr', 'ghost'])).toBe(2);
  });
});

describe('aw spawn prerequisites', () => {
  it('fails with exit code 3 and an install hint when the provider CLI is missing', async () => {
    const yaml = readFileSync(path.join(root, '.agents', 'workspace.yaml'), 'utf8').replace(
      '# Optional per-provider settings',
      'providers:\n  codex:\n    command: /nonexistent/codex\n\n# Optional per-provider settings',
    );
    writeFileSync(path.join(root, '.agents', 'workspace.yaml'), yaml);
    expect(await aw(['spawn', 'api'])).toBe(3);
    expect(ui.text()).toMatch(/Codex CLI not found/);
    expect(ui.text()).toMatch(/npm install -g @openai\/codex/);
  });
});
