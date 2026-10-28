import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { AccountView, ActivityEntry, ProviderInfo, TerminalCommand, WorkspaceController } from '../core/workspace/controller.js';
import type { Feature } from '../core/features/store.js';
import type { RoutingStats } from '../core/features/service.js';
import { attentionItems } from '../core/features/format.js';
import { EFFORTS, type Effort } from '../core/accounts/settings.js';
import type { AgentView, ProjectSnapshot, ProjectSummary } from '../core/workspace/snapshot.js';
import {
  type Command,
  type FeatureAction,
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
  SIDEBAR_WIDTH,
  Sidebar,
  TabBar,
} from './views.js';

/** What the TUI asks its launcher to do after it unmounts. */
export type Intent =
  | { type: 'quit' }
  | { type: 'attach'; session: string; agent: string }
  | { type: 'shell'; cwd: string }
  | { type: 'command'; command: TerminalCommand };

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
    `Account        ${agent.profile}`,
    `Feature        ${agent.feature ? `${agent.feature.title} (${agent.feature.id}/${agent.feature.task})` : 'manual agent'}`,
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
    'Keys: t attach · l logs · d diff · s start · x stop · r restart · R resume · c switch account',
  ].join('\n');
}

function hintsFor(view: ViewId, focus: UiState['focus']): string {
  if (focus === 'sidebar') return '↑↓ choose view · enter/→ open · tab main · ? help · q quit';
  switch (view) {
    case 'overview':
    case 'agents':
      return 'n new feature · + new agent · t attach · s start · x stop · r/R restart/resume · c account · l logs · d diff · enter details · ? help';
    case 'features':
      return 'n new feature · enter open plan · v details · P PR · X cancel · ? help · q quit';
    case 'accounts':
      return 'm mark limited/available · L log in · E edit accounts & routing · ? help · q quit';
    case 'projects':
      return 'enter select · + register · - forget · I init · o shell · p switch · ? help · q quit';
    default:
      return 'tab sidebar · 1-7 views · p projects · I init · o shell · u refresh · ? help · q quit';
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
  const [features, setFeatures] = useState<Feature[]>([]);
  const [accounts, setAccounts] = useState<AccountView[] | null>(null);
  const [stats, setStats] = useState<RoutingStats[]>([]);
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
      const snap = id ? await controller.snapshot(id) : null;
      setSnapshot(snap);
      setFeatures(id && snap?.state === 'ready' ? await controller.features(id) : []);
      setAccounts(await controller.accounts(id));
      if (id && uiRef.current.view === 'accounts') setStats(await controller.routingStats(id));
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
    if (ui.view === 'accounts' && ui.projectId) void controller.routingStats(ui.projectId).then(setStats);
  }, [ui.view, ui.projectId, providers, controller]);

  const agents = snapshot?.state === 'ready' ? snapshot.agents : [];
  const openFeature = ui.featureId ? features.find((f) => f.id === ui.featureId) : undefined;
  const lengths: Partial<Record<ViewId, number>> = {
    overview: agents.length,
    agents: agents.length,
    projects: projects.length,
    activity: activity.length,
    features: features.length,
    accounts: accounts?.length ?? 0,
  };
  const taskCount = openFeature?.tasks.length ?? 0;

  useEffect(() => {
    setUi((s) => {
      const clamped = clampCursors(s, lengths);
      const t = taskCount === 0 ? 0 : Math.min(clamped.taskCursor, taskCount - 1);
      return t === clamped.taskCursor ? clamped : { ...clamped, taskCursor: t };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length, projects.length, activity.length, features.length, accounts?.length, taskCount]);

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
        case 'approve':
          return run(`Approving ${target}`, () => controller.approveFeature(projectId, target));
        case 'cancel':
          return run(`Cancelling ${target}`, () => controller.cancelFeature(projectId, target));
        case 'pr':
          return run(`Publishing ${target} (push + pull request)`, () => controller.featurePr(projectId, target));
        case 'cleanup':
          return run(`Cleaning up ${target}`, () => controller.cleanupFeature(projectId, target));
        case 'account':
          return undefined;
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

  const accountPicker = (title: string, purpose: 'task-account' | 'agent-account', target: { feature?: string; task?: string; agent?: string }, current: string | null) => ({
    kind: 'picker' as const,
    title,
    purpose,
    target,
    cursor: Math.max(0, (accounts ?? []).filter((a) => a.allowed).findIndex((a) => a.name === current)),
    options: [...(accounts ?? [])]
      .sort((a, b) => Number(b.allowed) - Number(a.allowed))
      .map((a) => ({
        value: a.name,
        disabled: !a.allowed,
        label: `${a.name === current ? '● ' : '  '}${a.name.padEnd(18)} ${a.provider.padEnd(7)} ${a.mark ? 'limited' : a.loggedIn ? 'available' : 'not logged in'}${a.allowed ? '' : '  (not allowed in this project)'}`,
      })),
  });

  const handleFeature = async (action: FeatureAction, state: UiState): Promise<unknown> => {
    const projectId = state.projectId;
    if (!projectId) return flash('error', 'Select a project first (p).');
    if (action === 'new') return handle({ type: 'newFeature' }, state);
    if (action === 'close') return undefined;
    const feature = state.featureId ? features.find((f) => f.id === state.featureId) : features[state.cursors.features];
    if (!feature) return flash('error', state.view === 'features' ? 'No feature selected. Press n to create one.' : 'No feature selected.');
    const task = state.featureId ? feature.tasks[state.taskCursor] : undefined;
    const confirm = (title: string, message: string, act: 'approve' | 'cancel' | 'pr' | 'cleanup') =>
      setUi((s) => ({ ...s, overlay: { kind: 'confirm', title, message, pending: { kind: 'feature', action: act, projectId, target: feature.id } } }));
    const needTask = () => {
      flash('error', 'Select a task (↑↓) first.');
      return null;
    };
    switch (action) {
      case 'open':
        return setUi((s) => ({ ...s, featureId: feature.id, taskCursor: 0 }));
      case 'details': {
        setBusy('Loading details');
        const body = await controller.featureDetails(projectId, feature.id).finally(() => setBusy(null));
        return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `Feature ${feature.id}`, body, scroll: 0 } }));
      }
      case 'approve':
        if (feature.status !== 'review') return flash('info', `Only a plan in review can be approved (${feature.id} is ${feature.status}).`);
        return confirm(
          `Approve "${feature.title}"?`,
          `${feature.tasks.filter((t) => t.status !== 'skipped').length} task(s) will run on ${feature.branch}. Agents start in waves; each task is validated and merged into the feature branch (never into ${feature.base}). You will be asked only when a decision is needed.`,
          'approve',
        );
      case 'feedback':
        if (!['review', 'plan-failed', 'planning'].includes(feature.status)) return flash('info', 'Re-planning is only possible before approval.');
        return setUi((s) => ({ ...s, overlay: { kind: 'input', purpose: 'feature-feedback', title: 'What should change in the plan? (empty: just re-plan)', value: '', target: { feature: feature.id } } }));
      case 'effort': {
        if (!task) return needTask();
        if (feature.status !== 'review' && task.status !== 'pending') return flash('info', 'Effort can change before a task starts. For a running task, restart it with a new effort: aw restart <agent> --effort high.');
        const next = EFFORTS[(EFFORTS.indexOf(task.route.effort as Effort) + 1) % EFFORTS.length] as Effort;
        return run(`Effort of ${task.id}`, () => controller.setTaskRoute(projectId, feature.id, task.id, { effort: next }));
      }
      case 'account':
        if (!task) return needTask();
        if (feature.status === 'review' || task.status === 'pending') {
          return setUi((s) => ({ ...s, overlay: accountPicker(`Account for task ${task.id}`, 'task-account', { feature: feature.id, task: task.id }, task.route.account) }));
        }
        return setUi((s) => ({ ...s, overlay: accountPicker(`Continue ${task.agent} on which account? (relaunch with a handoff summary)`, 'agent-account', { agent: task.agent }, task.route.account) }));
      case 'skip':
        if (!task) return needTask();
        if (feature.status !== 'review') return flash('info', 'Tasks can be skipped during review only.');
        return run(task.status === 'skipped' ? `Restoring ${task.id}` : `Skipping ${task.id}`, () => controller.skipTask(projectId, feature.id, task.id, task.status !== 'skipped'));
      case 'answer':
        if (!task) return needTask();
        return setUi((s) => ({
          ...s,
          overlay: { kind: 'input', purpose: 'task-answer', title: task.status === 'blocked' ? `${task.id} asks: ${task.attention ?? ''}` : `Message for ${task.agent} (typed into its terminal)`, value: '', target: { feature: feature.id, task: task.id } },
        }));
      case 'retry':
        if (!task) return needTask();
        if (task.status !== 'attention' && task.status !== 'blocked') return flash('info', `${task.id} does not need a retry (${task.status}).`);
        return run(`Retrying ${task.id}`, () => controller.retryTask(projectId, feature.id, task.id));
      case 'integrate':
        if (!task) return needTask();
        if (task.status !== 'validated') return flash('info', `${task.id} is not waiting for integration (${task.status}).`);
        return run(`Integrating ${task.id}`, () => controller.integrateTask(projectId, feature.id, task.id));
      case 'pr':
        if (!['ready', 'pr-open', 'done'].includes(feature.status)) return flash('info', `Not ready yet: ${feature.tasks.filter((t) => t.status !== 'integrated' && t.status !== 'skipped').length} task(s) still in progress.`);
        return confirm(`Publish "${feature.title}"?`, `Pushes ${feature.branch} to the remote and opens (or refreshes) its pull request against ${feature.base}, after a secret scan. Nothing is merged.`, 'pr');
      case 'cancel':
        if (feature.status === 'cancelled' || feature.status === 'done') return flash('info', `${feature.id} is already ${feature.status}.`);
        return confirm(`Cancel "${feature.title}"?`, 'Its running agents are stopped. Worktrees, branches and commits are kept.', 'cancel');
      case 'cleanup':
        if (!['ready', 'pr-open', 'done', 'cancelled'].includes(feature.status)) return flash('info', 'Clean up after the feature is ready, published or cancelled.');
        return confirm(`Clean up "${feature.title}"?`, 'Stops its agents and removes their clean worktrees and the integration worktree. Branches (and the PR) are kept; worktrees with uncommitted work are kept.', 'cleanup');
      case 'attach':
      case 'logs':
      case 'diff': {
        if (!task) return needTask();
        const view = agents.find((a) => a.name === task.agent);
        if (!view) return flash('info', `${task.agent} has not started yet.`);
        if (action === 'attach') {
          try {
            return leave({ type: 'attach', session: await controller.attachTarget(projectId, view.name), agent: view.name });
          } catch (error) {
            return flash('error', error instanceof Error ? error.message : String(error));
          }
        }
        setBusy(`Reading ${view.name}`);
        const body = await (action === 'logs' ? controller.logs(projectId, view.name) : controller.diff(projectId, view.name)).finally(() => setBusy(null));
        const lines = body.split('\n').length;
        return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `${action === 'logs' ? 'Output' : 'Diff'} · ${view.name}`, body, scroll: action === 'logs' ? Math.max(0, lines - (size.rows - 6)) : 0 } }));
      }
    }
    return undefined;
  };

  const handle = useCallback(
    async (command: Command, state: UiState): Promise<unknown> => {
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
          if (!projectId) return flash('error', 'Select a project first (p).');
          if (snapshot?.state !== 'ready') return flash('error', snapshot?.state === 'not-initialized' ? 'Initialize the project first (I).' : 'The project is not ready.');
          return setUi((s) => ({
            ...s,
            overlay: {
              kind: 'input',
              purpose: 'feature-request',
              title: 'New feature: describe it like you would to Claude/Codex — goal, context, files to look at (paths), constraints. (Long text: aw feature new -f request.md)',
              value: '',
            },
          }));
        case 'pickerSelect': {
          if (state.overlay?.kind !== 'picker' || !projectId) return undefined;
          const { options, cursor, purpose, target } = state.overlay;
          const option = options[cursor];
          setUi((s) => ({ ...s, overlay: null }));
          if (!option || option.disabled) return flash('error', option ? 'That account is not allowed in this project.' : 'Cancelled.');
          if (option.label.startsWith('●')) return flash('info', `Already on ${option.value}.`);
          if (purpose === 'task-account' && target.feature && target.task) {
            const { feature, task } = target;
            return run(`Changing account of ${task}`, () => controller.setTaskRoute(projectId, feature, task, { account: option.value }));
          }
          if (purpose === 'agent-account' && target.agent) {
            const agent = target.agent;
            return run(`Switching ${agent} to ${option.value}`, () => controller.switchAgentAccount(projectId, agent, option.value));
          }
          return undefined;
        }
        case 'feature':
          return handleFeature(command.action, state);
        case 'account': {
          const account = accounts?.[state.cursors.accounts];
          if (command.action === 'edit') return leave({ type: 'command', command: await controller.editSettingsCommand() });
          if (!account) return flash('error', 'No account selected.');
          if (command.action === 'limit') return run(`Updating ${account.name}`, () => controller.setAccountLimited(account.name, !account.mark));
          if (command.action === 'login') {
            try {
              return leave({ type: 'command', command: await controller.loginCommand(account.name) });
            } catch (error) {
              return flash('error', error instanceof Error ? error.message : String(error));
            }
          }
          return undefined;
        }
        case 'switcherSelect': {
          if (state.overlay?.kind !== 'switcher') return undefined;
          const chosen = projects[state.overlay.cursor];
          if (!chosen) return setUi((s) => ({ ...s, overlay: null }));
          setUi((s) => ({ ...s, overlay: null, projectId: chosen.project.id, view: s.view === 'projects' ? 'overview' : s.view }));
          return flash('info', `Project: ${chosen.project.name}`);
        }
        case 'inputSubmit': {
          if (state.overlay?.kind !== 'input') return undefined;
          const { value: raw, purpose, draft } = state.overlay;
          const value = raw.trim();
          setUi((s) => ({ ...s, overlay: null }));
          if (purpose === 'agent-name') {
            if (!value) return flash('info', 'Cancelled.');
            if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) {
              return flash('error', 'Agent names use lowercase letters, digits, "-" or "_" (e.g. backend, auth-api).');
            }
            if (agents.some((a) => a.name === value)) return flash('error', `Agent "${value}" already exists.`);
            return setUi((s) => ({
              ...s,
              overlay: { kind: 'input', purpose: 'agent-provider', title: `Provider for "${value}": codex or claude`, value: 'codex', draft: { name: value } },
            }));
          }
          if (purpose === 'agent-provider') {
            if (value !== 'codex' && value !== 'claude') return flash('error', 'Provider must be "codex" or "claude".');
            return setUi((s) => ({
              ...s,
              overlay: {
                kind: 'input',
                purpose: 'agent-task',
                title: `What should "${draft?.name}" do? (one or two sentences; edit .agents/tasks/${draft?.name}.md later for detail)`,
                value: '',
                draft: { ...draft, provider: value },
              },
            }));
          }
          if (purpose === 'agent-task') {
            if (!projectId || !draft?.name || !draft.provider) return undefined;
            if (!value) return flash('error', 'Describe the task so the agent knows what to do.');
            const name = draft.name;
            const provider = draft.provider;
            return run(`Creating and starting ${name}`, () => controller.createAgent(projectId, name, { provider, task: value }));
          }
          if (purpose === 'feature-request') {
            if (!projectId) return undefined;
            if (!value) return flash('info', 'Cancelled.');
            setBusy('Creating the feature');
            const result = await controller.createFeature(projectId, value).finally(() => setBusy(null));
            flash(result.ok ? 'success' : 'error', result.message);
            if (result.ok && result.featureId) {
              const id = result.featureId;
              setUi((s) => ({ ...s, view: 'features', featureId: id, taskCursor: 0, focus: 'main' }));
            }
            return refresh();
          }
          if (purpose === 'feature-feedback' && state.overlay.target) {
            if (!projectId) return undefined;
            const { feature } = state.overlay.target;
            return run(`Re-planning ${feature}`, () => controller.replanFeature(projectId, feature, value));
          }
          if (purpose === 'task-answer' && state.overlay.target?.task) {
            if (!projectId || !value) return flash('info', 'Cancelled.');
            const { feature, task } = state.overlay.target;
            return run(`Answering ${task}`, () => controller.answerTask(projectId, feature, task as string, value));
          }
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
          if (command.action === 'create') {
            if (snapshot?.state !== 'ready') return flash('error', snapshot?.state === 'not-initialized' ? 'Initialize the project first (I).' : 'The project is not ready.');
            return setUi((s) => ({
              ...s,
              overlay: { kind: 'input', purpose: 'agent-name', title: 'New agent: name (e.g. backend, auth, docs)', value: '' },
            }));
          }
          const agent = selectedAgent(state);
          if (!agent) return flash('error', 'No agent selected.');
          const pending = (action: PendingAction['action']): PendingAction => ({ kind: 'agent', action, projectId, target: agent.name });
          switch (command.action) {
            case 'details':
              return setUi((s) => ({ ...s, overlay: { kind: 'text', title: `Agent ${agent.name}`, body: agentDetailsText(agent), scroll: 0 } }));
            case 'account':
              if (agent.session === 'not-spawned') return flash('info', `${agent.name} has not started yet; its account is chosen when it starts.`);
              return setUi((s) => ({ ...s, overlay: accountPicker(`Continue ${agent.name} on which account? It is relaunched in the same worktree with a handoff summary (its conversation does not carry over).`, 'agent-account', { agent: agent.name }, agent.profile) }));
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, agents, snapshot, features, accounts, controller, execute, flash, leave, refresh, run, size.rows],
  );

  useInput((input, key) => {
    const state = uiRef.current;
    const command = interpretKey(state, input, key);
    if (command.type === 'none') return;
    const textLines = state.overlay?.kind === 'text' ? state.overlay.body.split('\n').length : 0;
    const next = reduce(state, command, { lengths, projectCount: projects.length, textLines, textHeight: Math.max(3, size.rows - 6), taskCount });
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
  const mainWidth = wide ? columns - SIDEBAR_WIDTH - 2 : columns - 2;
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
        main = <OverviewView snapshot={snapshot} cursor={ui.cursors.overview} width={mainWidth - 2} height={contentHeight} projectCount={projects.length} needs={attentionItems(features)} />;
        break;
      case 'projects':
        main = <ProjectsView projects={projects} selectedId={ui.projectId} cursor={ui.cursors.projects} width={mainWidth - 2} height={contentHeight} loading={!projectsLoaded} />;
        break;
      case 'features':
        main = <FeaturesView snapshot={snapshot} features={features} cursor={ui.cursors.features} openFeature={ui.featureId} taskCursor={ui.taskCursor} width={mainWidth - 2} height={contentHeight} />;
        break;
      case 'agents':
        main = <AgentsView snapshot={snapshot} cursor={ui.cursors.agents} width={mainWidth - 2} height={contentHeight} />;
        break;
      case 'accounts':
        main = <AccountsView accounts={accounts} providers={providers} stats={stats} cursor={ui.cursors.accounts} width={mainWidth - 2} settingsPath={`${controller.settings().dataDir}/settings.yaml`} />;
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
        {wide ? <Sidebar view={ui.view} focused={ui.focus === 'sidebar'} height={bodyHeight} projects={projects} projectId={ui.projectId} features={features} openFeature={ui.featureId} /> : null}
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
        {truncate(ui.overlay ? `${VIEW_LABELS[ui.view]} · dialog open` : ui.view === 'features' && ui.featureId ? 'plan view · esc back to the feature list · ? help' : hintsFor(ui.view, ui.focus), columns)}
      </Text>
      <Text color={flashColor} wrap="truncate">
        {ui.flash ? truncate(ui.flash.text, columns) : ' '}
      </Text>
    </Box>
  );
}
