import path from 'node:path';
import type { Deps } from '../deps.js';
import { type AgentStatus, AgentService } from '../agents/service.js';
import { resolveAgent } from '../config/loader.js';
import { errorMessage, isAwError } from '../errors.js';
import { getSessionState, launchFilesFor } from '../sessions/launcher.js';
import type { ProjectRecord } from '../projects/registry.js';
import type { PrRecord } from '../state/runtime-state.js';
import { sessionPrefix, dashboardSessionName } from './workspace.js';
import { pathExists } from '../../infrastructure/filesystem/fs.js';
import type { Ui } from '../../infrastructure/terminal/ui.js';

/**
 * Read-only, structured views of live state for the TUI (and any future
 * frontend). Everything is derived from the same sources the CLI uses: the
 * per-repository runtime state, .agents/workspace.yaml, git and tmux.
 */

export type ProjectState = 'ready' | 'not-initialized' | 'missing' | 'invalid' | 'error';

export interface ProjectSummary {
  project: ProjectRecord;
  state: ProjectState;
  message: string | null;
  agents: number;
  running: number;
  /** Agents needing attention: exited, conflicted, missing worktree. */
  attention: number;
}

export interface AgentView extends AgentStatus {
  model: string | null;
  /** Provider account profile (Milestone 2); "default" uses the CLI's own login. */
  profile: string;
  /** Reasoning effort (Milestone 5); null when not configured. */
  effort: string | null;
  lastActivity: string | null;
}

export interface BranchView {
  name: string;
  agent: string | null;
  ahead: number | null;
  behind: number | null;
  worktree: string | null;
  pr: PrRecord | null;
  current: boolean;
}

export interface ProjectSnapshot {
  project: ProjectRecord;
  state: ProjectState;
  message: string | null;
  details: string[];
  hint: string | null;
  config: {
    name: string;
    baseBranch: string;
    remote: string;
    workspaceDir: string;
    configPath: string;
  } | null;
  agents: AgentView[];
  branches: BranchView[];
  /** aw tmux sessions for this project with no agent record. */
  orphanSessions: string[];
  warnings: string[];
  refreshedAt: string;
}

/** A Ui that records output instead of printing (services print progress; the TUI must not). */
export function recordingUi(sink: (kind: 'info' | 'warn' | 'error', text: string) => void): Ui {
  const info = (t: string) => sink('info', t);
  return {
    line: (t = '') => t && info(t),
    header: () => undefined,
    kv: () => undefined,
    ok: info,
    fail: (t) => sink('error', t),
    warn: (t) => sink('warn', t),
    info,
    hint: () => undefined,
    error: (t) => sink('error', t),
    stderr: (t) => sink('warn', t),
  };
}

export class SnapshotService {
  constructor(private readonly deps: Deps) {}

  /** AgentService bound to a project directory, with output captured. */
  serviceFor(project: ProjectRecord, sink: (kind: 'info' | 'warn' | 'error', text: string) => void = () => undefined): AgentService {
    return new AgentService({
      ...this.deps,
      cwd: project.path,
      ui: recordingUi(sink),
      // Frontends confirm before calling; never prompt on the terminal behind their back.
      prompter: { confirm: async (_question, options) => Boolean(options?.assumeYes) },
    });
  }

  private classify(error: unknown): { state: ProjectState; message: string; details: string[]; hint: string | null } {
    const message = errorMessage(error);
    const details = isAwError(error) ? error.details : [];
    const hint = isAwError(error) ? (error.hint ?? null) : null;
    if (/not been initialized/.test(message)) {
      return { state: 'not-initialized', message: 'Not initialized for Agent Workspace', details, hint: 'Press I to run "aw init" here.' };
    }
    if (/Invalid (configuration|YAML)/.test(message)) return { state: 'invalid', message, details, hint };
    return { state: 'error', message, details, hint };
  }

  async summarize(project: ProjectRecord): Promise<ProjectSummary> {
    const base = { project, agents: 0, running: 0, attention: 0 };
    if (!(await pathExists(project.path))) {
      return { ...base, state: 'missing', message: 'Directory not found (moved or deleted?)' };
    }
    try {
      const service = this.serviceFor(project);
      const ws = await service.open();
      const state = await ws.state.load();
      const names = new Set([...Object.keys(ws.config.agents), ...Object.keys(state.agents)]);
      let running = 0;
      let attention = 0;
      for (const record of Object.values(state.agents)) {
        if (!record.session) continue;
        const sessionState = await getSessionState(this.deps.terminal, record.session.name, launchFilesFor(ws.state.agentDir(record.name)).exitFile);
        if (sessionState === 'running') running++;
        if (sessionState === 'exited') attention++;
      }
      return { ...base, state: 'ready', message: null, agents: names.size, running, attention };
    } catch (error) {
      const c = this.classify(error);
      return { ...base, state: c.state, message: c.message };
    }
  }

  async snapshot(project: ProjectRecord): Promise<ProjectSnapshot> {
    const empty: ProjectSnapshot = {
      project,
      state: 'ready',
      message: null,
      details: [],
      hint: null,
      config: null,
      agents: [],
      branches: [],
      orphanSessions: [],
      warnings: [],
      refreshedAt: new Date().toISOString(),
    };
    if (!(await pathExists(project.path))) {
      return {
        ...empty,
        state: 'missing',
        message: `Directory not found: ${project.path}`,
        hint: 'If the repository moved, register it again at its new path, then forget this entry.',
      };
    }
    const service = this.serviceFor(project);
    let ws;
    try {
      ws = await service.open();
    } catch (error) {
      const c = this.classify(error);
      return { ...empty, state: c.state, message: c.message, details: c.details, hint: c.hint };
    }

    const statuses = await service.collectStatus(ws);
    const activity = await this.deps.terminal.sessionActivity();
    const agents: AgentView[] = statuses.map((s) => {
      const resolved = resolveAgent(ws.config, s.name, { provider: s.provider });
      return {
        ...s,
        model: resolved.model ?? null,
        profile: 'default',
        effort: null,
        lastActivity: activity.get(s.sessionName)?.toISOString() ?? s.lastLaunchAt,
      };
    });

    const cwd = service.repoCwd(ws);
    const state = await ws.state.load();
    const base = await service.comparisonBase(ws, ws.config.project.baseBranch);
    const current = await this.deps.git.currentBranch(cwd);
    const refs = await this.deps.git.run(cwd, ['for-each-ref', '--sort=-committerdate', '--count=40', '--format=%(refname:short)', 'refs/heads']);
    const branchNames = refs.exitCode === 0 ? refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
    const worktrees = await this.deps.git.listWorktrees(cwd).catch(() => []);
    const branches: BranchView[] = [];
    for (const name of branchNames) {
      const agent = agents.find((a) => a.branch === name) ?? null;
      const counts = base && name !== ws.config.project.baseBranch ? await this.deps.git.aheadBehind(cwd, base, name) : null;
      branches.push({
        name,
        agent: agent?.name ?? null,
        ahead: counts?.ahead ?? null,
        behind: counts?.behind ?? null,
        worktree: worktrees.find((w) => w.branch === name)?.path ?? null,
        pr: (agent && (state.prs?.[agent.name] ?? state.agents[agent.name]?.pr)) || null,
        current: name === current,
      });
    }

    const prefix = sessionPrefix(ws);
    const known = new Set(agents.map((a) => a.sessionName));
    const orphanSessions = (await this.deps.terminal.listSessions()).filter(
      (s) => s.startsWith(prefix) && s !== dashboardSessionName(ws) && !known.has(s),
    );

    return {
      ...empty,
      config: {
        name: ws.projectName,
        baseBranch: ws.config.project.baseBranch,
        remote: ws.config.project.remote,
        workspaceDir: ws.workspaceDir,
        configPath: path.relative(ws.configRoot, ws.loaded.path) || ws.loaded.path,
      },
      agents,
      branches,
      orphanSessions,
      warnings: ws.loaded.warnings,
    };
  }
}

export function attentionCount(agents: AgentView[]): number {
  return agents.filter((a) => a.session === 'exited' || (a.changes?.conflicted ?? 0) > 0 || (a.spawned && !a.worktreeExists)).length;
}

