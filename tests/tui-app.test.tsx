import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App, type Intent } from '../src/tui/App.js';
import { initialUiState, type UiState } from '../src/tui/state.js';
import type { AccountView, ActionResult, ActivityEntry, ProviderInfo, SettingsInfo, TerminalCommand, WorkspaceController } from '../src/core/workspace/controller.js';
import type { Feature } from '../src/core/features/store.js';
import type { Effort } from '../src/core/accounts/settings.js';
import type { AgentView, ProjectSnapshot, ProjectSummary } from '../src/core/workspace/snapshot.js';
import type { ProjectRecord } from '../src/core/projects/registry.js';

/** Rendering and interaction tests of the Ink app against an in-memory controller. */

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function agent(name: string, session: AgentView['session'], extra: Partial<AgentView> = {}): AgentView {
  return {
    name,
    provider: name === 'auth' ? 'claude' : 'codex',
    branch: `agent/${name}`,
    base: 'main',
    configured: true,
    spawned: session !== 'not-spawned',
    worktreePath: `/ws/${name}`,
    worktreeExists: session !== 'not-spawned',
    session,
    sessionName: `aw-shop-abc123-${name}`,
    exitCode: session === 'exited' ? 1 : null,
    changes: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    ahead: 2,
    behind: 0,
    task: { path: `.agents/tasks/${name}.md`, title: `Build ${name}`, exists: true, template: false },
    description: null,
    dependsOn: [],
    pr: name === 'api' ? { number: 12, url: 'https://github.com/acme/shop/pull/12', state: 'OPEN', isDraft: true, updatedAt: '' } : null,
    lastLaunchAt: null,
    model: null,
    profile: 'default',
    effort: null,
    lastActivity: new Date().toISOString(),
    feature: null,
    ...extra,
  };
}

class FakeController implements WorkspaceController {
  calls: string[] = [];
  projects: ProjectRecord[] = [
    { id: 'prj_shop', name: 'shop', path: '/repos/shop', commonDir: '/repos/shop/.git', registeredAt: '', lastOpenedAt: '' },
    { id: 'prj_blog', name: 'blog', path: '/repos/blog', commonDir: '/repos/blog/.git', registeredAt: '', lastOpenedAt: '' },
  ];
  agents: AgentView[] = [agent('api', 'running'), agent('auth', 'exited'), agent('web', 'not-spawned')];
  private log: ActivityEntry[] = [];

  async initialProject() {
    return this.projects[0] ?? null;
  }
  async listProjects(): Promise<ProjectSummary[]> {
    return this.projects.map((p) => ({
      project: p,
      state: p.id === 'prj_blog' ? 'not-initialized' : 'ready',
      message: p.id === 'prj_blog' ? 'Not initialized for Agent Workspace' : null,
      agents: 3,
      running: 1,
      attention: 1,
    }));
  }
  async snapshot(id: string): Promise<ProjectSnapshot> {
    const project = this.projects.find((p) => p.id === id)!;
    if (id === 'prj_blog') {
      return { project, state: 'not-initialized', message: 'Not initialized for Agent Workspace', details: [], hint: 'Press I to run "aw init" here.', config: null, agents: [], branches: [], orphanSessions: [], warnings: [], refreshedAt: '' };
    }
    return {
      project,
      state: 'ready',
      message: null,
      details: [],
      hint: null,
      config: { name: 'shop', baseBranch: 'main', remote: 'origin', workspaceDir: '/ws', configPath: '.agents/workspace.yaml' },
      agents: this.agents,
      branches: [{ name: 'agent/api', agent: 'api', ahead: 2, behind: 0, worktree: '/ws/api', pr: this.agents[0]!.pr ?? null, current: false }],
      orphanSessions: [],
      warnings: [],
      refreshedAt: '',
    };
  }
  private done(text: string): ActionResult {
    this.calls.push(text);
    this.log.unshift({ at: new Date().toISOString(), project: 'shop', kind: 'success', text });
    return { ok: true, message: text };
  }
  async registerProject(p: string) {
    const project: ProjectRecord = { id: 'prj_new', name: 'new', path: p, commonDir: '', registeredAt: '', lastOpenedAt: '' };
    this.projects.push(project);
    return { ...this.done(`register ${p}`), project };
  }
  async forgetProject(id: string) {
    return this.done(`forget ${id}`);
  }
  async createAgent(_p: string, a: string, o: { provider: string; task: string }) {
    return this.done(`create ${a} ${o.provider} ${o.task}`);
  }
  async initProject(id: string) {
    return this.done(`init ${id}`);
  }
  async startAgent(_p: string, a: string) {
    return this.done(`start ${a}`);
  }
  async stopAgent(_p: string, a: string) {
    return this.done(`stop ${a}`);
  }
  async restartAgent(_p: string, a: string, o: { resume?: boolean } = {}) {
    return this.done(`restart ${a}${o.resume ? ' resume' : ''}`);
  }
  async attachTarget(_p: string, a: string) {
    return `aw-shop-abc123-${a}`;
  }
  async logs(_p: string, a: string) {
    return `[aw] Starting agent ${a}\nline 2`;
  }
  async diff(_p: string, a: string) {
    return `# ${a} · diff\n+added line`;
  }
  async refreshPullRequests() {
    return this.done('prs');
  }
  async providers(): Promise<ProviderInfo[]> {
    return [{ id: 'codex', name: 'Codex', installed: true, version: '0.165.0', missingFlags: [], installHint: '' }];
  }
  settings(): SettingsInfo {
    return { version: '0.2.0', dataDir: '/data/aw', registryFile: '/data/aw/projects.json', tmuxSocket: null, workspaceDirOverride: null };
  }
  activity() {
    return [...this.log];
  }
  async projectPath(id: string) {
    return this.projects.find((p) => p.id === id)?.path ?? '/';
  }

  featureList: Feature[] = [];
  async features() {
    return this.featureList;
  }
  async featureDetails(_p: string, id: string) {
    return `Feature ${id} details\n# Plan`;
  }
  async createFeature(_p: string, request: string) {
    this.featureList.unshift(makeFeature('new-feature', 'planning', request));
    return { ...this.done(`feature ${request}`), featureId: 'new-feature' };
  }
  async replanFeature(_p: string, id: string, feedback: string) {
    return this.done(`replan ${id} ${feedback}`);
  }
  async approveFeature(_p: string, id: string) {
    return this.done(`approve ${id}`);
  }
  async cancelFeature(_p: string, id: string) {
    return this.done(`cancel ${id}`);
  }
  async setTaskRoute(_p: string, id: string, task: string, change: { account?: string; effort?: Effort }) {
    return this.done(`route ${id}/${task} ${change.account ?? ''}${change.effort ?? ''}`);
  }
  async skipTask(_p: string, id: string, task: string, skip: boolean) {
    return this.done(`skip ${id}/${task} ${skip}`);
  }
  async answerTask(_p: string, id: string, task: string, text: string) {
    return this.done(`answer ${id}/${task} ${text}`);
  }
  async retryTask(_p: string, id: string, task: string) {
    return this.done(`retry ${id}/${task}`);
  }
  async integrateTask(_p: string, id: string, task: string) {
    return this.done(`integrate ${id}/${task}`);
  }
  async featurePr(_p: string, id: string) {
    return this.done(`pr ${id}`);
  }
  async cleanupFeature(_p: string, id: string) {
    return this.done(`cleanup ${id}`);
  }
  accountList: AccountView[] = [
    { name: 'codex-work', provider: 'codex', label: 'codex-work', home: '/h/cw', tags: ['work'], implicit: false, allowed: true, loggedIn: true, mark: null },
    { name: 'codex-personal', provider: 'codex', label: 'codex-personal', home: '/h/cp', tags: ['personal'], implicit: false, allowed: false, loggedIn: true, mark: null },
    { name: 'claude-work', provider: 'claude', label: 'claude-work', home: null, tags: ['work'], implicit: false, allowed: true, loggedIn: true, mark: null },
  ];
  async accounts() {
    return this.accountList;
  }
  async setAccountLimited(name: string, limited: boolean) {
    return this.done(`limit ${name} ${limited}`);
  }
  async switchAgentAccount(_p: string, agent: string, account: string) {
    return this.done(`switch ${agent} ${account}`);
  }
  async loginCommand(name: string): Promise<TerminalCommand> {
    return { command: 'codex', args: ['login'], env: { CODEX_HOME: `/h/${name}` }, cwd: '/', label: `login ${name}` };
  }
  async editSettingsCommand(): Promise<TerminalCommand> {
    return { command: 'nano', args: ['/data/aw/settings.yaml'], env: {}, cwd: '/', label: 'edit' };
  }
  async routingStats() {
    return [{ key: 'low complexity · codex · effort low', tasks: 4, firstPass: 3 }];
  }
}

function makeFeature(id: string, status: Feature['status'], request = 'Add JWT auth'): Feature {
  const route = (account: string, effort: string) => ({ account, provider: account.split('-')[0] as string, model: null, effort, reason: `rule 1 → ${account}`, warnings: [] });
  const t = (tid: string, extra: Partial<Feature['tasks'][number]> = {}): Feature['tasks'][number] => ({
    id: tid,
    agent: `${id}-${tid}`,
    status: 'pending',
    route: route('codex-work', 'medium'),
    attempts: 0,
    conflicts: 0,
    report: null,
    validation: null,
    attention: null,
    startedAt: null,
    integratedAt: null,
    firstPass: null,
    validatedSha: null,
    limitSeen: null,
    ...extra,
  });
  const ptask = (tid: string, dependsOn: string[] = []) => ({
    id: tid,
    title: `Build ${tid}`,
    objective: `Implement ${tid}`,
    context: '',
    scope: [`src/${tid}/**`],
    dependsOn,
    acceptance: ['works'],
    validation: ['npm test'],
    complexity: 'medium' as const,
    risk: 'high' as const,
    rationale: 'touches auth',
    suggestedProvider: 'any' as const,
    suggestedEffort: 'high' as const,
  });
  return {
    version: 1,
    id,
    title: id === 'new-feature' ? 'New feature' : 'JWT auth',
    request,
    status,
    createdAt: '2026-10-28T10:00:00Z',
    updatedAt: '2026-10-28T10:00:00Z',
    base: 'main',
    branch: `feature/${id}`,
    planner: { route: route('claude-work', 'high'), startedAt: null, finishedAt: null, error: null },
    feedback: [],
    plan: status === 'planning' ? null : { title: 'JWT auth', summary: 'Adds JWT login.', approach: 'schema first', questions: [], tasks: [ptask('schema'), ptask('api', ['schema'])] },
    planWarnings: [],
    tasks: status === 'planning' ? [] : [t('schema', status === 'running' ? { status: 'blocked', attention: 'RS256 or HS256?', startedAt: 'x' } : {}), t('api')],
    integrate: 'auto',
    pr: null,
  };
}

function mount(controller = new FakeController(), state: UiState = initialUiState('prj_shop')) {
  const intents: Array<{ intent: Intent; state: UiState }> = [];
  const app = render(<App controller={controller} initialState={state} refreshMs={60_000} onIntent={(intent, s) => intents.push({ intent, state: s })} />);
  // A roomy terminal (the default test stdout is 100 columns).
  Object.defineProperty(app.stdout, 'columns', { value: 150, configurable: true });
  Object.defineProperty(app.stdout, 'rows', { value: 45, configurable: true });
  app.stdout.emit('resize');
  return { ...app, controller, intents };
}

async function keys(app: ReturnType<typeof mount>, ...sequence: string[]) {
  for (const k of sequence) {
    app.stdin.write(k);
    await tick();
  }
}

describe('TUI app', () => {
  it('shows the sidebar, the selected project, agents, branches and PRs', async () => {
    const app = mount();
    await tick(150);
    const frame = app.lastFrame() ?? '';
    for (const label of ['1 Overview', '2 Projects', '3 Features', '4 Agents', '5 Accounts', '6 Activity', '7 Settings']) expect(frame).toContain(label);
    expect(frame).toContain('Agent Workspace · shop · 1/3 running');
    expect(frame).toContain('auth: agent exited (1), press r to restart');
    expect(frame).toContain('#12 draft');
    expect(frame).toContain('agent/api');
    app.unmount();
  });

  it('navigates to agents, opens details, logs and diffs, and attaches through an intent', async () => {
    const app = mount();
    await tick(150);
    await keys(app, 'a');
    expect(app.lastFrame()).toContain('Agents · shop');
    expect(app.lastFrame()).toContain('Account       default');
    await keys(app, '\r');
    expect(app.lastFrame()).toContain('Agent api');
    await keys(app, '\u001B');
    await keys(app, 'l');
    expect(app.lastFrame()).toContain('Output · api');
    expect(app.lastFrame()).toContain('[aw] Starting agent api');
    await keys(app, 'q', 'd');
    expect(app.lastFrame()).toContain('+added line');
    await keys(app, '\u001B', 't');
    expect(app.intents).toEqual([expect.objectContaining({ intent: { type: 'attach', session: 'aw-shop-abc123-api', agent: 'api' } })]);
    expect(app.intents[0]?.state.view).toBe('agents'); // view state survives the attach
  });

  it('confirms before stopping or restarting a running agent and restarts exited agents directly', async () => {
    const app = mount();
    await tick(150);
    await keys(app, 'a', 'x');
    expect(app.lastFrame()).toContain('Stop api?');
    expect(app.lastFrame()).toContain('the worktree, branch, commits and');
    await keys(app, 'n');
    expect(app.controller.calls).toEqual([]);
    expect(app.lastFrame()).toContain('Cancelled.');
    await keys(app, 'x', 'y');
    await tick(100);
    expect(app.controller.calls).toEqual(['stop api']);
    await keys(app, 'R', 'y');
    await tick(100);
    expect(app.controller.calls).toContain('restart api resume');
    await keys(app, '\u001B[B', 'r'); // auth has exited: no confirmation needed
    await tick(100);
    expect(app.controller.calls).toContain('restart auth');
    await keys(app, '\u001B[B', 's'); // web was never started
    await tick(100);
    expect(app.controller.calls).toContain('start web');
    app.unmount();
  });

  it('registers and switches projects and explains uninitialized ones', async () => {
    const app = mount();
    await tick(150);
    await keys(app, '2');
    expect(app.lastFrame()).toContain('Not initialized for Agent Workspa');
    await keys(app, '+');
    for (const ch of '/repos/new') app.stdin.write(ch);
    await tick();
    expect(app.lastFrame()).toContain('> /repos/new');
    await keys(app, '\r');
    await tick(100);
    expect(app.controller.calls).toContain('register /repos/new');
    await keys(app, 'p', '\u001B[B', '\r', '1');
    await tick(100);
    expect(app.lastFrame()).toContain('Press I to run "aw init" here.');
    app.unmount();
  });

  it('creates an agent through a three-step form and initializes projects from any view', async () => {
    const app = mount();
    await tick(150);
    await keys(app, 'a', '+');
    expect(app.lastFrame()).toContain('New agent: name');
    for (const ch of 'docs') app.stdin.write(ch);
    await keys(app, '\r');
    expect(app.lastFrame()).toContain('Provider for "docs"');
    expect(app.lastFrame()).toContain('> codex');
    await keys(app, '\r'); // keep the suggested provider
    expect(app.lastFrame()).not.toContain('Provider must be');
    expect(app.lastFrame()).toContain('What should "docs" do?');
    for (const ch of 'Write the API docs') app.stdin.write(ch);
    await keys(app, '\r');
    await tick(100);
    expect(app.controller.calls).toContain('create docs codex Write the API docs');

    await keys(app, '+');
    for (const ch of 'Bad Name') app.stdin.write(ch);
    await keys(app, '\r');
    expect(app.lastFrame()).toContain('Agent names use lowercase letters');

    // "I" works from the Overview of an uninitialized project, not only in Projects.
    await keys(app, 'p', '\u001B[B', '\r', '1', 'I');
    await tick(100);
    expect(app.controller.calls).toContain('init prj_blog');
    app.unmount();
  });

  it('shows meaningful empty states', async () => {
    const controller = new FakeController();
    controller.projects = [];
    const app = mount(controller, initialUiState(null));
    await tick(150);
    expect(app.lastFrame()).toContain('Welcome to Agent Workspace');
    await keys(app, '3');
    expect(app.lastFrame()).toContain('No project selected');
    await keys(app, '5');
    await tick(100);
    expect(app.lastFrame()).toContain('codex-work');
    await keys(app, '6');
    expect(app.lastFrame()).toContain('Actions you take here');
    await keys(app, '7');
    expect(app.lastFrame()).toContain('/data/aw/projects.json');
    await keys(app, 'n');
    expect(app.lastFrame()).toContain('Select a project first');
    app.unmount();
  });

  it('switches to a compact tab bar on narrow terminals and quits without side effects', async () => {
    const app = mount();
    Object.defineProperty(app.stdout, 'columns', { value: 70, configurable: true });
    app.stdout.emit('resize');
    await tick(150);
    expect(app.lastFrame()).toContain('[1 Overview] 2 Projects');
    await keys(app, 'q');
    expect(app.intents.map((i) => i.intent)).toEqual([{ type: 'quit' }]);
    expect(app.controller.calls).toEqual([]);
  });

  it('creates a feature with n and opens its plan view while it plans', async () => {
    const app = mount();
    await tick(150);
    await keys(app, 'n');
    expect(app.lastFrame()).toContain('New feature: describe it');
    for (const ch of 'Add JWT login, see docs/auth.md') app.stdin.write(ch);
    await keys(app, '\r');
    await tick(150);
    expect(app.controller.calls).toContain('feature Add JWT login, see docs/auth.md');
    expect(app.lastFrame()).toContain('is reading the repository');
    expect(app.lastFrame()).toContain('new-feature'); // sidebar tree
    await keys(app, '\u001B');
    expect(app.lastFrame()).toContain('planning…');
    app.unmount();
  });

  it('reviews a plan: account picker respects the project policy, effort cycles, approve asks first', async () => {
    const controller = new FakeController();
    controller.featureList = [makeFeature('jwt-auth', 'review')];
    const app = mount(controller);
    await tick(150);
    expect(app.lastFrame()).toContain('JWT auth: plan ready for review'); // Needs you
    await keys(app, '3', '\r');
    expect(app.lastFrame()).toContain('Waves: 1) schema   2) api');
    expect(app.lastFrame()).toContain('why codex-work · effort medium: rule 1 → codex-work');
    await keys(app, 'c');
    expect(app.lastFrame()).toContain('Account for task schema');
    expect(app.lastFrame()).toContain('(not allowed in this project)');
    await keys(app, 'j', '\r');
    await tick(100);
    expect(controller.calls).toContain('route jwt-auth/schema claude-work');
    await keys(app, 'j', 'e');
    await tick(100);
    expect(controller.calls).toContain('route jwt-auth/api high');
    await keys(app, ' ');
    await tick(100);
    expect(controller.calls).toContain('skip jwt-auth/api true');
    await keys(app, 'f');
    for (const ch of 'one task only') app.stdin.write(ch);
    await keys(app, '\r');
    await tick(100);
    expect(controller.calls).toContain('replan jwt-auth one task only');
    await keys(app, 'A');
    expect(app.lastFrame()).toContain('Approve "JWT auth"?');
    expect(app.lastFrame()).toContain('never into main');
    await keys(app, 'y');
    await tick(100);
    expect(controller.calls).toContain('approve jwt-auth');
    app.unmount();
  });

  it('answers blocked tasks and switches agent accounts from the dashboard', async () => {
    const controller = new FakeController();
    controller.featureList = [makeFeature('jwt-auth', 'running')];
    const app = mount(controller);
    await tick(150);
    expect(app.lastFrame()).toContain('jwt-auth/schema asks: RS256 or HS256?');
    await keys(app, '3', '\r', 'w');
    expect(app.lastFrame()).toContain('schema asks: RS256 or HS256?');
    for (const ch of 'RS256') app.stdin.write(ch);
    await keys(app, '\r');
    await tick(100);
    expect(controller.calls).toContain('answer jwt-auth/schema RS256');
    // Switching the account of a running agent from the Agents view.
    await keys(app, '\u001B', 'a', 'c');
    expect(app.lastFrame()).toContain('Continue api on which account?');
    await keys(app, 'j', '\r');
    await tick(100);
    expect(controller.calls).toContain('switch api claude-work');
    app.unmount();
  });

  it('manages accounts: marks, login hand-over and routing results', async () => {
    const app = mount();
    await tick(150);
    await keys(app, '5');
    await tick(150);
    expect(app.lastFrame()).toContain('not allowed');
    expect(app.lastFrame()).toContain('3/4 (75%)');
    await keys(app, 'm');
    await tick(100);
    expect(app.controller.calls).toContain('limit codex-work true');
    await keys(app, 'L');
    await tick(50);
    expect(app.intents.at(-1)?.intent).toEqual({ type: 'command', command: { command: 'codex', args: ['login'], env: { CODEX_HOME: '/h/codex-work' }, cwd: '/', label: 'login codex-work' } });
  });
});
