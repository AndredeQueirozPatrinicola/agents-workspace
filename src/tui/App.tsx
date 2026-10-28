import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ActivityEntry, ProviderInfo, WorkspaceController } from '../core/workspace/controller.js';
import type { AgentView, ProjectSnapshot, ProjectSummary } from '../core/workspace/snapshot.js';
import {
  type Command,
  type PendingAction,
  type UiState,
  type ViewId,
  VIEW_LABELS,
  clampCursors,
  interpretKey,
  reduce,
} from './state.js';
import { aheadBehindText, changesText, prText, relativeTime, sessionText, shortPath, truncate } from './format.js';
import {
  AccountsView,
  ActivityView,
  AgentsView,
  FeaturesView,
  OverlayView,
  OverviewView,
  ProjectsView,
  SettingsView,
  Sidebar,
  TabBar,
} from './views.js';

/** What the TUI asks its launcher to do after it unmounts. */
export type Intent = { type: 'quit' } | { type: 'attach'; session: string; agent: string } | { type: 'shell'; cwd: string };

export interface AppProps {
  controller: WorkspaceController;
  initialState: UiState;
  onIntent: (intent: Intent, state: UiState) => void;
  refreshMs?: number;
  /** Message shown once on start (e.g. the result of a previous attach). */
  initialFlash?: UiState['flash'];
}

const SIDEBAR_MIN_WIDTH = 90;

export function agentDetailsText(agent: AgentView): string {
  return [
    `Agent          ${agent.name}`,
    `State          ${sessionText(agent)}`,
    `Provider       ${agent.provider}`,
    `Profile        ${agent.profile}`,
    `Model          ${agent.model ?? 'provider default'}`,
    `Effort         ${agent.effort ?? 'provider default'}`,
    `Task           ${agent.task.title ?? agent.description ?? '-'}`,
    `Task file      ${agent.task.path}${agent.task.template ? ' [template]' : ''}`,
    `Branch         ${agent.branch} (base ${agent.base}, ${aheadBehindText(agent.ahead, agent.behind)})`,
    `Worktree       ${agent.worktreePath ? shortPath(agent.worktreePath) : 'not created'}${agent.worktreePath && !agent.worktreeExists ? ' (missing)' : ''}`,
    `Changes        ${changesText(agent.changes)}`,
    `tmux session   ${agent.sessionName}`,
    `Last activity  ${relativeTime(agent.lastActivity)}`,
    `Exit status    ${agent.exitCode ?? '-'}`,
    `Pull request   ${agent.pr ? `${prText(agent.pr)} ${agent.pr.url}` : '-'}`,
    `Depends on     ${agent.dependsOn.map((d) => `${d.name} (${d.state})`).join(', ') || '-'}`,
    '',
    'Keys: t attach · l logs · d diff · s start · x stop · r restart · R resume',
  ].join('\n');
}

function hintsFor(view: ViewId, focus: UiState['focus']): string {
  if (focus === 'sidebar') return '↑↓ choose view · enter/→ open · tab main · ? help · q quit';
  switch (view) {
    case 'overview':
    case 'agents':
      return 't attach · s start · x stop · r restart · R resume · l logs · d diff · enter details · p projects · ? help · q quit';
    case 'projects':
      return 'enter select · + register · - forget · I init · o shell · p switch · ? help · q quit';
    default:
      return 'tab sidebar · 1-7 views · p projects · u refresh · ? help · q quit';
  }
}

export function App({ controller, initialState, onIntent, refreshMs = 3000, initialFlash = null }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [ui, setUi] = useState<UiState>(() => ({ ...initialState, flash: initialFlash ?? initialState.flash }));
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<ProjectSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>(() => controller.activity());
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [size, setSize] = useState({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const loading = useRef(false);

  useEffect(() => {
    const onResize = () => setSize({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const flash = useCallback((kind: 'info' | 'success' | 'error', text: string) => {
    setUi((s) => ({ ...s, flash: { kind, text } }));
  }, []);

  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const list = await controller.listProjects();
      setProjects(list);
      setProjectsLoaded(true);
      const id = uiRef.current.projectId ?? list[0]?.project.id ?? null;
      if (id && id !== uiRef.current.projectId) setUi((s) => ({ ...s, projectId: id }));
      setSnapshot(id ? await controller.snapshot(id) : null);
      setActivity(controller.activity());
      setRefreshedAt(new Date());
    } catch (error) {
      flash('error', `Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loading.current = false;
    }
  }, [controller, flash]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);

  // Refresh immediately when the selected project changes.
  useEffect(() => {
    void refresh();
  }, [ui.projectId, refresh]);

  useEffect(() => {
    if (ui.view === 'accounts' && providers === null) void controller.providers().then(setProviders);
  }, [ui.view, providers, controller]);

  const agents = snapshot?.state === 'ready' ? snapshot.agents : [];
  const lengths: Partial<Record<ViewId, number>> = {
    overview: agents.length,
    agents: agents.length,
    projects: projects.length,
    activity: activity.length,
  };

  useEffect(() => {
    setUi((s) => clampCursors(s, lengths));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length, projects.length, activity.length]);

  const leave = useCallback(
    (intent: Intent) => {
      onIntent(intent, { ...uiRef.current, overlay: null, flash: null });
      exit();
    },
    [exit, onIntent],
  );

  const run = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; message: string }>) => {
      setBusy(label);
      try {
        const result = await fn();
        flash(result.ok ? 'success' : 'error', result.message);
      } catch (error) {
        flash('error', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [flash, refresh],
  );

  const selectedAgent = (state: UiState): AgentView | undefined => {
    const view = state.view === 'overview' ? 'overview' : 'agents';
    return agents[state.cursors[view]];
  };

  const execute = useCallback(
    async (pending: PendingAction) => {
      const { projectId, target } = pending;
      switch (pending.action) {
        case 'stop':
          return run(`Stopping ${target}`, () => controller.stopAgent(projectId, target));
        case 'restart':
          return run(`Restarting ${target}`, () => controller.restartAgent(projectId, target));
        case 'resume':
          return run(`Restarting ${target}`, () => controller.restartAgent(projectId, target, { resume: true }));
        case 'forget':
          return run('Forgetting project', async () => {
            const result = await controller.forgetProject(projectId);
            if (result.ok && uiRef.current.projectId === projectId) setUi((s) => ({ ...s, projectId: null }));
            return result;
          });
        default:
          return undefined;
      }
    },
    [controller, run],
  );

  const handle = useCallback(
    async (command: Command, state: UiState) => {
      const projectId = state.projectId;
      switch (command.type) {
        case 'quit':
          return leave({ type: 'quit' });
        case 'refresh':
          flash('info', 'Refreshing…');
          return refresh();
        case 'refreshPrs':
          if (!projectId) return flash('error', 'Select a project first (p).');
          return run('Fetching pull requests from GitHub', () => controller.refreshPullRequests(projectId));
        case 'newFeature':
          return flash('info', 'Natural-language features arrive in Milestone 3. For now press o for a shell and use aw spawn <name> --task "...".');
        case 'switcherSelect': {
          if (state.overlay?.kind !== 'switcher') return undefined;
          const chosen = projects[state.overlay.cursor];
          if (!chosen) return setUi((s) => ({ ...s, overlay: null }));
          setUi((s) => ({ ...s, overlay: null, projectId: chosen.project.id, view: s.view === 'projects' ? 'overview' : s.view }));
          return flash('info', `Project: ${chosen.project.name}`);
        }
        case 'inputSubmit': {
          if (state.overlay?.kind !== 'input') return undefined;
          const value = state.overlay.value.trim();
          setUi((s) => ({ ...s, overlay: null }));
          if (!value) return undefined;
          return run('Registering repository', async () => {
            const result = await controller.registerProject(value);
            if (result.ok && result.project) setUi((s) => ({ ...s, projectId: result.project?.id ?? s.projectId }));
            return result;
          });
        }
        case 'confirm': {
          if (state.overlay?.kind !== 'confirm') return undefined;
          const pending = state.overlay.pending;
          setUi((s) => ({ ...s, overlay: null }));
          return command.yes ? execute(pending) : flash('info', 'Cancelled.');
        }
        case 'project': {
          if (command.action === 'register') {
            return setUi((s) => ({ ...s, overlay: { kind: 'input', title: 'Register a Git repository: path (absolute, ~/…, or relative to where aw started)', value: '', purpose: 'register' } }));
          }
          const summary = state.view === 'projects' ? projects[state.cursors.projects] : projects.find((p) => p.project.id === projectId);
          if (!summary) return flash('error', 'No project selected.');
          const id = summary.project.id;
          switch (command.action) {
            case 'select':
              setUi((s) => ({ ...s, projectId: id }));
              return flash('info', `Project: ${summary.project.name}`);
            case 'forget':
              return setUi((s) => ({
                ...s,
                overlay: {
                  kind: 'confirm',
                  title: `Forget ${summary.project.name}?`,
                  message: `It disappears from Agent Workspace's list. Nothing in ${shortPath(summary.project.path)} is changed; running agents keep running.`,
                  pending: { kind: 'project', action: 'forget', projectId: id, target: summary.project.name },
                },
              }));
            case 'init':
              if (summary.state !== 'not-initialized') return flash('info', `${summary.project.name} is ${summary.state === 'ready' ? 'already initialized' : summary.state}.`);
              return run('Initializing', () => controller.initProject(id));
            case 'shell':
              return leave({ type: 'shell', cwd: await controller.projectPath(id) });
          }
          return undefined;
        }
        case 'agent': {
          if (!projectId) return flash('error', 'Select a project first (p).');
          const agent = selectedAgent(state);
          if (!agent) return flash('error', 'No agent selected.');
          const pending = (action: PendingAction['action']): PendingAction => ({ kind: 'agent', action, projectId, target: agent.name });
          switch (command.action) {
            case 'details':
              return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `Agent ${agent.name}`, body: agentDetailsText(agent), scroll: 0 } }));
            case 'attach':
              try {
                return leave({ type: 'attach', session: await controller.attachTarget(projectId, agent.name), agent: agent.name });
              } catch (error) {
                return flash('error', error instanceof Error ? error.message : String(error));
              }
            case 'start':
              if (agent.session === 'running') return flash('info', `${agent.name} is already running (t to attach).`);
              if (agent.session === 'exited') return execute(pending('restart'));
              return run(`Starting ${agent.name}`, () => controller.startAgent(projectId, agent.name));
            case 'stop':
              if (agent.session === 'stopped' || agent.session === 'not-spawned') return flash('info', `${agent.name} is not running.`);
              return setUi((s) => ({
                ...s,
                overlay: {
                  kind: 'confirm',
                  title: `Stop ${agent.name}?`,
                  message: `${agent.session === 'running' ? 'The agent is running and will be interrupted. ' : ''}Its tmux session closes; the worktree, branch, commits and uncommitted changes are kept.`,
                  pending: pending('stop'),
                },
              }));
            case 'restart':
            case 'resume': {
              if (agent.session === 'not-spawned' || agent.session === 'stopped') {
                return run(`Starting ${agent.name}`, () => controller.startAgent(projectId, agent.name, { resume: command.action === 'resume' }));
              }
              if (agent.session === 'exited') return execute(pending(command.action));
              return setUi((s) => ({
                ...s,
                overlay: {
                  kind: 'confirm',
                  title: `Restart ${agent.name}?`,
                  message: `The running agent will be interrupted and relaunched in the same tmux session${command.action === 'resume' ? ', continuing its previous conversation' : ' with a new conversation'}. Work in the worktree is kept.`,
                  pending: pending(command.action),
                },
              }));
            }
            case 'logs': {
              setBusy(`Reading output of ${agent.name}`);
              const body = await controller.logs(projectId, agent.name).finally(() => setBusy(null));
              const lines = body.split('\n').length;
              return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `Output · ${agent.name}`, body, scroll: Math.max(0, lines - (size.rows - 6)) } }));
            }
            case 'diff': {
              setBusy(`Computing diff of ${agent.name}`);
              const body = await controller.diff(projectId, agent.name).finally(() => setBusy(null));
              return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `Diff · ${agent.name}`, body, scroll: 0 } }));
            }
          }
          return undefined;
        }
        default:
          return undefined;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, agents, controller, execute, flash, leave, refresh, run, size.rows],
  );

  useInput((input, key) => {
    const state = uiRef.current;
    const command = interpretKey(state, input, key);
    if (command.type === 'none') return;
    const textLines = state.overlay?.kind === 'text' ? state.overlay.body.split('\n').length : 0;
    const next = reduce(state, command, { lengths, projectCount: projects.length, textLines, textHeight: Math.max(3, size.rows - 6) });
    if (next !== state) {
      uiRef.current = next;
      setUi(next);
    }
    void handle(command, next);
  });

  // ---------------------------------------------------------------- layout
  const columns = Math.max(40, size.columns);
  const rows = Math.max(12, size.rows);
  const wide = columns >= SIDEBAR_MIN_WIDTH;
  const bodyHeight = rows - 3 - (wide ? 0 : 1);
  const mainWidth = wide ? columns - 16 - 2 : columns - 2;
  const project = projects.find((p) => p.project.id === ui.projectId)?.project ?? snapshot?.project ?? null;
  const running = agents.filter((a) => a.session === 'running').length;

  const header = `Agent Workspace · ${project ? project.name : 'no project'}${snapshot?.state === 'ready' ? ` · ${running}/${agents.length} running` : ''}${busy ? ` · ${busy}…` : ''}`;
  const clock = refreshedAt ? `↻ ${refreshedAt.toLocaleTimeString()}` : 'loading…';

  let main: React.ReactNode;
  const contentHeight = bodyHeight - 2;
  if (ui.overlay) {
    main = <OverlayView overlay={ui.overlay} projects={projects} width={mainWidth} height={contentHeight} />;
  } else {
    switch (ui.view) {
      case 'overview':
        main = <OverviewView snapshot={snapshot} cursor={ui.cursors.overview} width={mainWidth - 2} height={contentHeight} projectCount={projects.length} />;
        break;
      case 'projects':
        main = <ProjectsView projects={projects} selectedId={ui.projectId} cursor={ui.cursors.projects} width={mainWidth - 2} height={contentHeight} loading={!projectsLoaded} />;
        break;
      case 'features':
        main = <FeaturesView snapshot={snapshot} />;
        break;
      case 'agents':
        main = <AgentsView snapshot={snapshot} cursor={ui.cursors.agents} width={mainWidth - 2} height={contentHeight} />;
        break;
      case 'accounts':
        main = <AccountsView providers={providers} width={mainWidth - 2} />;
        break;
      case 'activity':
        main = <ActivityView entries={activity} cursor={ui.cursors.activity} width={mainWidth - 2} height={contentHeight} />;
        break;
      case 'settings':
        main = <SettingsView settings={controller.settings()} snapshot={snapshot} refreshMs={refreshMs} />;
        break;
    }
  }

  const flashColor = ui.flash?.kind === 'error' ? 'red' : ui.flash?.kind === 'success' ? 'green' : 'cyan';
  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box justifyContent="space-between">
        <Text bold color="cyan" wrap="truncate">
          {truncate(header, columns - clock.length - 2)}
        </Text>
        <Text color="gray">{clock}</Text>
      </Box>
      {wide ? null : <TabBar view={ui.view} width={columns} />}
      <Box height={bodyHeight}>
        {wide ? <Sidebar view={ui.view} focused={ui.focus === 'sidebar'} height={bodyHeight} /> : null}
        <Box
          flexDirection="column"
          flexGrow={1}
          height={bodyHeight}
          borderStyle="single"
          borderColor={ui.focus === 'main' && !ui.overlay ? 'cyan' : 'gray'}
          paddingX={1}
          overflow="hidden"
        >
          {main}
        </Box>
      </Box>
      <Text color="gray" wrap="truncate">
        {truncate(ui.overlay ? `${VIEW_LABELS[ui.view]} · dialog open` : hintsFor(ui.view, ui.focus), columns)}
      </Text>
      <Text color={flashColor} wrap="truncate">
        {ui.flash ? truncate(ui.flash.text, columns) : ' '}
      </Text>
    </Box>
  );
}
