import path from 'node:path';
import type { Deps } from '../deps.js';
import { AwError, ExitCode, errorMessage, isAwError } from '../errors.js';
import { PrService } from '../github/pr-service.js';
import type { ProjectRecord } from '../projects/registry.js';
import { type ProjectSnapshot, type ProjectSummary, SnapshotService, recordingUi } from './snapshot.js';
import { initWorkspace } from './init.js';
import { packageVersion } from '../../infrastructure/filesystem/package-root.js';
import { displayPath } from '../../infrastructure/filesystem/fs.js';

/**
 * The boundary between frontends (the Ink TUI today) and the application.
 * Frontends never run git, tmux or provider commands themselves; they call
 * this interface, which composes the existing services. Orchestration
 * (Milestone 3+) will be exposed through the same controller.
 */

export interface ActivityEntry {
  at: string;
  project: string | null;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  installed: boolean;
  version: string | null;
  missingFlags: string[];
  installHint: string;
}

export interface SettingsInfo {
  version: string;
  dataDir: string;
  registryFile: string;
  tmuxSocket: string | null;
  workspaceDirOverride: string | null;
}

export interface WorkspaceController {
  /** Project for the directory aw was started in (registered automatically if initialized). */
  initialProject(): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectSummary[]>;
  snapshot(projectId: string): Promise<ProjectSnapshot>;
  registerProject(anyPath: string): Promise<ActionResult & { project?: ProjectRecord }>;
  forgetProject(projectId: string): Promise<ActionResult>;
  initProject(projectId: string): Promise<ActionResult>;
  /** Add an agent to workspace.yaml with a task, then start it. */
  createAgent(projectId: string, agent: string, options: { provider: string; task: string }): Promise<ActionResult>;
  startAgent(projectId: string, agent: string, options?: { resume?: boolean }): Promise<ActionResult>;
  stopAgent(projectId: string, agent: string): Promise<ActionResult>;
  restartAgent(projectId: string, agent: string, options?: { resume?: boolean }): Promise<ActionResult>;
  /** Session to attach to (the frontend suspends itself and attaches). */
  attachTarget(projectId: string, agent: string): Promise<string>;
  logs(projectId: string, agent: string): Promise<string>;
  diff(projectId: string, agent: string): Promise<string>;
  refreshPullRequests(projectId: string): Promise<ActionResult>;
  providers(): Promise<ProviderInfo[]>;
  settings(): SettingsInfo;
  activity(): ActivityEntry[];
  /** Directory to open a shell in for a project. */
  projectPath(projectId: string): Promise<string>;
}

const MAX_ACTIVITY = 200;
const MAX_DIFF_LINES = 600;

export class LiveWorkspaceController implements WorkspaceController {
  private readonly snapshots: SnapshotService;
  private readonly log: ActivityEntry[] = [];
  private providerCache: { at: number; value: ProviderInfo[] } | null = null;

  constructor(private readonly deps: Deps) {
    this.snapshots = new SnapshotService(deps);
  }

  private record(project: string | null, kind: ActivityEntry['kind'], text: string): void {
    this.log.unshift({ at: new Date().toISOString(), project, kind, text });
    if (this.log.length > MAX_ACTIVITY) this.log.length = MAX_ACTIVITY;
  }

  activity(): ActivityEntry[] {
    return [...this.log];
  }

  private async project(projectId: string): Promise<ProjectRecord> {
    const project = await this.deps.projects.get(projectId);
    if (!project) throw new AwError(`Unknown project ${projectId}.`, { exitCode: ExitCode.USAGE });
    return project;
  }

  /** Run a service action, capturing its output as activity and turning errors into results. */
  private async act(projectId: string, label: string, fn: (p: ProjectRecord, sink: (k: 'info' | 'warn' | 'error', t: string) => void) => Promise<void>): Promise<ActionResult> {
    let project: ProjectRecord;
    try {
      project = await this.project(projectId);
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    }
    const sink = (kind: 'info' | 'warn' | 'error', text: string) => this.record(project.name, kind, text);
    try {
      await fn(project, sink);
      this.record(project.name, 'success', label);
      return { ok: true, message: label };
    } catch (error) {
      const message = isAwError(error) ? [error.message, ...error.details.slice(0, 3), error.hint].filter(Boolean).join(' — ') : errorMessage(error);
      this.record(project.name, 'error', `${label} failed: ${message}`);
      return { ok: false, message };
    }
  }

  async initialProject(): Promise<ProjectRecord | null> {
    const known = await this.deps.projects.findContaining(this.deps.cwd);
    if (known) {
      await this.deps.projects.touch(known.id).catch(() => undefined);
      return known;
    }
    // Register the current repository automatically only if it is already initialized.
    try {
      const service = new SnapshotService(this.deps).serviceFor({
        id: '',
        name: '',
        path: this.deps.cwd,
        commonDir: '',
        registeredAt: '',
        lastOpenedAt: '',
      });
      const ws = await service.open();
      const { project } = await this.deps.projects.register(ws.configRoot);
      return project;
    } catch {
      const list = await this.deps.projects.list();
      return list[0] ?? null;
    }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.deps.projects.list();
    return Promise.all(projects.map((p) => this.snapshots.summarize(p)));
  }

  async snapshot(projectId: string): Promise<ProjectSnapshot> {
    return this.snapshots.snapshot(await this.project(projectId));
  }

  async registerProject(anyPath: string): Promise<ActionResult & { project?: ProjectRecord }> {
    try {
      const target = path.resolve(this.deps.cwd, anyPath.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
      const { project, created } = await this.deps.projects.register(target);
      const message = `${created ? 'Registered' : 'Already registered'} ${project.name} (${displayPath(project.path)})`;
      this.record(project.name, 'success', message);
      return { ok: true, message, project };
    } catch (error) {
      const message = errorMessage(error);
      this.record(null, 'error', `Register failed: ${message}`);
      return { ok: false, message };
    }
  }

  async forgetProject(projectId: string): Promise<ActionResult> {
    const project = await this.deps.projects.get(projectId);
    if (!project) return { ok: false, message: 'Unknown project' };
    await this.deps.projects.remove(project.id);
    const message = `Forgot ${project.name} (nothing in the repository was changed)`;
    this.record(project.name, 'success', message);
    return { ok: true, message };
  }

  async initProject(projectId: string): Promise<ActionResult> {
    let hasCommits = true;
    const result = await this.act(projectId, 'Initialized .agents/workspace.yaml', async (project, sink) => {
      hasCommits = (await initWorkspace({ ...this.deps, cwd: project.path, ui: recordingUi(sink) })).hasCommits;
    });
    if (result.ok && !hasCommits) {
      return {
        ok: true,
        message: 'Initialized. The repository has no commits yet: commit once (o for a shell, then git add .agents && git commit -m "Add Agent Workspace") before creating agents.',
      };
    }
    return result.ok ? { ok: true, message: 'Initialized .agents/workspace.yaml. Next: + in Agents to create an agent (commit .agents/ when convenient).' } : result;
  }

  createAgent(projectId: string, agent: string, options: { provider: string; task: string }): Promise<ActionResult> {
    return this.act(projectId, `Created and started ${agent} (${options.provider})`, async (project, sink) => {
      await this.snapshots.serviceFor(project, sink).spawn(agent, { provider: options.provider, taskText: options.task });
    });
  }

  startAgent(projectId: string, agent: string, options: { resume?: boolean } = {}): Promise<ActionResult> {
    return this.act(projectId, `Started ${agent}`, async (project, sink) => {
      await this.snapshots.serviceFor(project, sink).spawn(agent, { resume: options.resume });
    });
  }

  stopAgent(projectId: string, agent: string): Promise<ActionResult> {
    return this.act(projectId, `Stopped ${agent} (worktree and branch kept)`, async (project, sink) => {
      await this.snapshots.serviceFor(project, sink).stop(agent, { yes: true });
    });
  }

  restartAgent(projectId: string, agent: string, options: { resume?: boolean } = {}): Promise<ActionResult> {
    return this.act(projectId, `Restarted ${agent}${options.resume ? ' (resumed)' : ''}`, async (project, sink) => {
      await this.snapshots.serviceFor(project, sink).restart(agent, { yes: true, resume: options.resume });
    });
  }

  async attachTarget(projectId: string, agent: string): Promise<string> {
    const snap = await this.snapshot(projectId);
    const view = snap.agents.find((a) => a.name === agent);
    if (!view || view.session === 'stopped' || view.session === 'not-spawned') {
      throw new AwError(`Agent "${agent}" has no tmux session.`, { hint: 'Start it first (s).' });
    }
    return view.sessionName;
  }

  async logs(projectId: string, agent: string): Promise<string> {
    const snap = await this.snapshot(projectId);
    const view = snap.agents.find((a) => a.name === agent);
    if (!view) return `Unknown agent ${agent}.`;
    if (!(await this.deps.terminal.hasSession(view.sessionName))) {
      return `Agent "${agent}" has no tmux session, so there is no terminal output to show.\nStart it with "s", or run: aw spawn ${agent}`;
    }
    const text = (await this.deps.terminal.capture(view.sessionName, 1000)).replace(/\s+$/g, '');
    return text || '(no output yet)';
  }

  async diff(projectId: string, agent: string): Promise<string> {
    const snap = await this.snapshot(projectId);
    const view = snap.agents.find((a) => a.name === agent);
    if (!view?.worktreePath || !view.worktreeExists) return `Agent "${agent}" has no worktree yet.`;
    const project = await this.project(projectId);
    const service = this.snapshots.serviceFor(project);
    const ws = await service.open();
    const base = (await service.comparisonBase(ws, view.base)) ?? view.base;
    const git = this.deps.git;
    const wt = view.worktreePath;
    const out = async (args: string[]) => {
      const r = await git.run(wt, args);
      return (r.exitCode === 0 ? r.stdout : r.stderr).replace(/\s+$/g, '');
    };
    const sections: string[] = [];
    sections.push(`# ${agent} · ${view.branch} vs ${base}`, '');
    const status = await out(['status', '--short']);
    sections.push('## Uncommitted changes', status || '(none)', '');
    const log = await out(['log', '--oneline', '--no-decorate', `${base}..${view.branch}`]);
    sections.push(`## Commits not in ${base}`, log || '(none)', '');
    const stat = await out(['diff', '--stat', `${base}...${view.branch}`]);
    sections.push('## Files changed on the branch', stat || '(none)', '');
    const committed = await out(['diff', '--no-color', '--no-ext-diff', `${base}...${view.branch}`]);
    const uncommitted = await out(['diff', '--no-color', '--no-ext-diff', 'HEAD']);
    if (committed) sections.push('## Branch diff', committed, '');
    if (uncommitted) sections.push('## Uncommitted diff', uncommitted, '');
    const lines = sections.join('\n').split('\n');
    if (lines.length > MAX_DIFF_LINES) {
      return [...lines.slice(0, MAX_DIFF_LINES), '', `… ${lines.length - MAX_DIFF_LINES} more lines. Full diff: git -C ${wt} diff ${base}...${view.branch}`].join('\n');
    }
    return lines.join('\n');
  }

  refreshPullRequests(projectId: string): Promise<ActionResult> {
    return this.act(projectId, 'Pull request status refreshed from GitHub', async (project, sink) => {
      const deps = { ...this.deps, cwd: project.path, ui: recordingUi(sink) };
      const agents = this.snapshots.serviceFor(project, sink);
      const rows = await new PrService(deps, agents).status();
      const failed = rows.filter((r) => r.error);
      if (failed.length === rows.length && rows.length > 0) throw new AwError(failed[0]?.error ?? 'GitHub request failed');
    });
  }

  async providers(): Promise<ProviderInfo[]> {
    if (this.providerCache && Date.now() - this.providerCache.at < 60_000) return this.providerCache.value;
    const value: ProviderInfo[] = [];
    for (const provider of this.deps.providers.all()) {
      const probe = await provider.probe().catch(() => ({ installed: false, path: null, version: null, missingFlags: [] }));
      value.push({
        id: provider.id,
        name: provider.displayName,
        installed: probe.installed,
        version: probe.version,
        missingFlags: probe.missingFlags,
        installHint: provider.installHint,
      });
    }
    this.providerCache = { at: Date.now(), value };
    return value;
  }

  settings(): SettingsInfo {
    return {
      version: packageVersion(),
      dataDir: this.deps.dataDir,
      registryFile: this.deps.projects.file,
      tmuxSocket: this.deps.env.AW_TMUX_SOCKET || null,
      workspaceDirOverride: this.deps.env.AW_WORKSPACE_DIR || null,
    };
  }

  async projectPath(projectId: string): Promise<string> {
    return (await this.project(projectId)).path;
  }
}
