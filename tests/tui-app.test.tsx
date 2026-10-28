import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App, type Intent } from '../src/tui/App.js';
import { initialUiState, type UiState } from '../src/tui/state.js';
import type { ActionResult, ActivityEntry, ProviderInfo, SettingsInfo, WorkspaceController } from '../src/core/workspace/controller.js';
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
}

function mount(controller = new FakeController(), state: UiState = initialUiState('prj_shop')) {
  const intents: Array<{ intent: Intent; state: UiState }> = [];
  const app = render(<App controller={controller} initialState={state} refreshMs={60_000} onIntent={(intent, s) => intents.push({ intent, state: s })} />);
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
    expect(app.lastFrame()).toContain('Profile       default');
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
    expect(app.lastFrame()).toContain('worktree, branch, commits and uncommitted changes are kept');
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

  it('shows meaningful empty states', async () => {
    const controller = new FakeController();
    controller.projects = [];
    const app = mount(controller, initialUiState(null));
    await tick(150);
    expect(app.lastFrame()).toContain('Welcome to Agent Workspace');
    await keys(app, '3');
    expect(app.lastFrame()).toContain('Natural-language features');
    await keys(app, '5');
    await tick(100);
    expect(app.lastFrame()).toContain('profile: default');
    await keys(app, '6');
    expect(app.lastFrame()).toContain('Actions you take here');
    await keys(app, '7');
    expect(app.lastFrame()).toContain('/data/aw/projects.json');
    await keys(app, 'n');
    expect(app.lastFrame()).toContain('Milestone 3');
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
});
