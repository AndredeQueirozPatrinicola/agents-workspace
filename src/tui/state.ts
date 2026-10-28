/**
 * Pure UI state for the TUI: navigation, focus, overlays and the mapping
 * from keys to commands. No I/O here, so it is fully unit-testable; App.tsx
 * performs the side effects that commands request.
 */

export const VIEWS = ['overview', 'projects', 'features', 'agents', 'accounts', 'activity', 'settings'] as const;
export type ViewId = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<ViewId, string> = {
  overview: 'Overview',
  projects: 'Projects',
  features: 'Features',
  agents: 'Agents',
  accounts: 'Accounts',
  activity: 'Activity',
  settings: 'Settings',
};

/** What a text input dialog is collecting. The new-agent form is three inputs in a row. */
export type InputPurpose = 'register' | 'agent-name' | 'agent-provider' | 'agent-task' | 'feature-request' | 'feature-feedback' | 'task-answer';

export interface AgentDraft {
  name?: string;
  provider?: string;
}

export type AgentAction = 'create' | 'attach' | 'start' | 'stop' | 'restart' | 'resume' | 'logs' | 'diff' | 'details' | 'account';
export type ProjectAction = 'select' | 'register' | 'forget' | 'init' | 'shell';
/** Feature list (no feature open) and plan view (a feature open) actions. */
export type FeatureAction =
  | 'open'
  | 'close'
  | 'new'
  | 'details'
  | 'approve'
  | 'feedback'
  | 'effort'
  | 'account'
  | 'skip'
  | 'answer'
  | 'retry'
  | 'integrate'
  | 'pr'
  | 'cancel'
  | 'cleanup'
  | 'attach'
  | 'logs'
  | 'diff';
export type AccountAction = 'limit' | 'login' | 'edit';

/** Actions that need a confirmation before running. */
export interface PendingAction {
  kind: 'agent' | 'project' | 'feature';
  action: AgentAction | ProjectAction | FeatureAction;
  projectId: string;
  target: string;
  /** Feature task id, for feature actions on a task. */
  task?: string;
}

export interface PickerOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type PickerPurpose = 'task-account' | 'agent-account';

export type Overlay =
  | { kind: 'help' }
  | { kind: 'confirm'; title: string; message: string; pending: PendingAction }
  | { kind: 'text'; title: string; body: string; scroll: number }
  | { kind: 'input'; title: string; value: string; purpose: InputPurpose; draft?: AgentDraft; target?: { feature: string; task?: string } }
  | { kind: 'switcher'; cursor: number }
  | { kind: 'picker'; title: string; options: PickerOption[]; cursor: number; purpose: PickerPurpose; target: { feature?: string; task?: string; agent?: string } };

export interface Flash {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UiState {
  view: ViewId;
  focus: 'sidebar' | 'main';
  projectId: string | null;
  /** Feature open in the Features view (plan view), or null for the feature list. */
  featureId: string | null;
  /** Task cursor inside the plan view. */
  taskCursor: number;
  cursors: Record<ViewId, number>;
  overlay: Overlay | null;
  flash: Flash | null;
}

export function initialUiState(projectId: string | null = null): UiState {
  return {
    view: 'overview',
    focus: 'main',
    projectId,
    featureId: null,
    taskCursor: 0,
    cursors: { overview: 0, projects: 0, features: 0, agents: 0, accounts: 0, activity: 0, settings: 0 },
    overlay: null,
    flash: null,
  };
}

export type Command =
  | { type: 'none' }
  | { type: 'quit' }
  | { type: 'setView'; view: ViewId }
  | { type: 'toggleFocus' }
  | { type: 'focus'; focus: 'sidebar' | 'main' }
  | { type: 'move'; delta: number }
  | { type: 'moveView'; delta: number }
  | { type: 'openHelp' }
  | { type: 'closeOverlay' }
  | { type: 'openSwitcher' }
  | { type: 'switcherMove'; delta: number }
  | { type: 'switcherSelect' }
  | { type: 'agent'; action: AgentAction }
  | { type: 'project'; action: ProjectAction }
  | { type: 'feature'; action: FeatureAction }
  | { type: 'account'; action: AccountAction }
  | { type: 'pickerMove'; delta: number }
  | { type: 'pickerSelect' }
  | { type: 'refresh' }
  | { type: 'refreshPrs' }
  | { type: 'newFeature' }
  | { type: 'scroll'; delta: number }
  | { type: 'inputChar'; text: string }
  | { type: 'inputBackspace' }
  | { type: 'inputSubmit' }
  | { type: 'confirm'; yes: boolean };

/** Subset of Ink's Key we rely on (kept structural so tests can build it easily). */
export interface KeyInfo {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** Translate a key press into a command, given the current state. */
export function interpretKey(state: UiState, input: string, key: KeyInfo): Command {
  const overlay = state.overlay;
  if (key.ctrl && input === 'c') return overlay ? { type: 'closeOverlay' } : { type: 'quit' };

  if (overlay) {
    switch (overlay.kind) {
      case 'help':
        return key.escape || input === 'q' || input === '?' || key.return ? { type: 'closeOverlay' } : { type: 'none' };
      case 'confirm':
        if (input === 'y' || input === 'Y') return { type: 'confirm', yes: true };
        if (input === 'n' || input === 'N' || key.escape || input === 'q') return { type: 'confirm', yes: false };
        return { type: 'none' };
      case 'text':
        if (key.escape || input === 'q' || input === '?' || key.return) return { type: 'closeOverlay' };
        if (key.downArrow || input === 'j') return { type: 'scroll', delta: 1 };
        if (key.upArrow || input === 'k') return { type: 'scroll', delta: -1 };
        if (key.pageDown || input === ' ') return { type: 'scroll', delta: 20 };
        if (key.pageUp || input === 'b') return { type: 'scroll', delta: -20 };
        if (input === 'G') return { type: 'scroll', delta: Number.MAX_SAFE_INTEGER };
        if (input === 'g') return { type: 'scroll', delta: Number.MIN_SAFE_INTEGER };
        return { type: 'none' };
      case 'input':
        if (key.escape) return { type: 'closeOverlay' };
        if (key.return) return { type: 'inputSubmit' };
        if (key.backspace || key.delete) return { type: 'inputBackspace' };
        if (input && !key.ctrl && !key.meta && !key.tab) return { type: 'inputChar', text: input };
        return { type: 'none' };
      case 'picker':
        if (key.escape || input === 'q') return { type: 'closeOverlay' };
        if (key.downArrow || input === 'j') return { type: 'pickerMove', delta: 1 };
        if (key.upArrow || input === 'k') return { type: 'pickerMove', delta: -1 };
        if (key.return) return { type: 'pickerSelect' };
        return { type: 'none' };
      case 'switcher':
        if (key.escape || input === 'q' || input === 'p') return { type: 'closeOverlay' };
        if (key.downArrow || input === 'j') return { type: 'switcherMove', delta: 1 };
        if (key.upArrow || input === 'k') return { type: 'switcherMove', delta: -1 };
        if (key.return) return { type: 'switcherSelect' };
        if (input === '+') return { type: 'project', action: 'register' };
        return { type: 'none' };
    }
  }

  // Global keys
  if (input === 'q') return { type: 'quit' };
  if (input === '?') return { type: 'openHelp' };
  if (key.tab) return { type: 'toggleFocus' };
  if (input === 'p') return { type: 'openSwitcher' };
  if (input === 'a') return { type: 'setView', view: 'agents' };
  if (input === 'n') return { type: 'newFeature' };
  if (input === 'u') return { type: 'refresh' };
  if (input === 'g') return { type: 'refreshPrs' };
  if (/^[1-7]$/.test(input)) return { type: 'setView', view: VIEWS[Number(input) - 1] as ViewId };

  if (state.focus === 'sidebar') {
    if (key.downArrow || input === 'j') return { type: 'moveView', delta: 1 };
    if (key.upArrow || input === 'k') return { type: 'moveView', delta: -1 };
    if (key.return || key.rightArrow || input === 'l') return { type: 'focus', focus: 'main' };
    return { type: 'none' };
  }

  // Main panel
  if (state.view === 'features' && state.featureId) {
    // Plan view of one feature.
    if (key.escape || key.leftArrow) return { type: 'feature', action: 'close' };
    if (key.downArrow || input === 'j') return { type: 'move', delta: 1 };
    if (key.upArrow || input === 'k') return { type: 'move', delta: -1 };
    const planKeys: Record<string, FeatureAction> = {
      A: 'approve',
      f: 'feedback',
      e: 'effort',
      c: 'account',
      ' ': 'skip',
      w: 'answer',
      r: 'retry',
      i: 'integrate',
      P: 'pr',
      X: 'cancel',
      C: 'cleanup',
      v: 'details',
      t: 'attach',
      l: 'logs',
      d: 'diff',
    };
    const action = planKeys[input];
    if (action) return { type: 'feature', action };
    if (key.return) return { type: 'feature', action: 'details' };
  }
  if (key.escape || key.leftArrow) return { type: 'focus', focus: 'sidebar' };
  if (key.downArrow || input === 'j') return { type: 'move', delta: 1 };
  if (key.upArrow || input === 'k') return { type: 'move', delta: -1 };
  if (key.pageDown) return { type: 'move', delta: 10 };
  if (key.pageUp) return { type: 'move', delta: -10 };

  if (state.view === 'agents' || state.view === 'overview') {
    if (key.return) return { type: 'agent', action: 'details' };
    if (input === '+') return { type: 'agent', action: 'create' };
    if (input === 't') return { type: 'agent', action: 'attach' };
    if (input === 's') return { type: 'agent', action: 'start' };
    if (input === 'x') return { type: 'agent', action: 'stop' };
    if (input === 'r') return { type: 'agent', action: 'restart' };
    if (input === 'R') return { type: 'agent', action: 'resume' };
    if (input === 'l') return { type: 'agent', action: 'logs' };
    if (input === 'd') return { type: 'agent', action: 'diff' };
  }
  if (state.view === 'agents' || state.view === 'overview') {
    if (input === 'c') return { type: 'agent', action: 'account' };
  }
  if (state.view === 'features') {
    if (key.return) return { type: 'feature', action: 'open' };
    if (input === '+') return { type: 'feature', action: 'new' };
    if (input === 'v') return { type: 'feature', action: 'details' };
    if (input === 'X') return { type: 'feature', action: 'cancel' };
    if (input === 'P') return { type: 'feature', action: 'pr' };
    if (input === 'C') return { type: 'feature', action: 'cleanup' };
  }
  if (state.view === 'accounts') {
    if (input === 'm') return { type: 'account', action: 'limit' };
    if (input === 'L') return { type: 'account', action: 'login' };
    if (input === 'E') return { type: 'account', action: 'edit' };
  }
  if (state.view === 'projects') {
    if (key.return) return { type: 'project', action: 'select' };
    if (input === '+' || input === 'i') return { type: 'project', action: 'register' };
    if (input === '-' || input === 'x') return { type: 'project', action: 'forget' };
  }
  // Project-level keys that work from every view (they act on the selected project;
  // in the Projects view, on the highlighted row).
  if (input === 'I') return { type: 'project', action: 'init' };
  if (input === 'o') return { type: 'project', action: 'shell' };
  return { type: 'none' };
}

export interface ReduceContext {
  /** Number of selectable rows per view. */
  lengths: Partial<Record<ViewId, number>>;
  /** Number of projects (for the switcher). */
  projectCount: number;
  /** Body line count of the text overlay. */
  textLines?: number;
  /** Visible lines in the text overlay. */
  textHeight?: number;
  /** Tasks of the open feature. */
  taskCount?: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Apply pure commands. Commands with side effects are returned unchanged by App for handling. */
export function reduce(state: UiState, command: Command, ctx: ReduceContext): UiState {
  switch (command.type) {
    case 'setView':
      return { ...state, view: command.view, focus: 'main', overlay: null };
    case 'toggleFocus':
      return { ...state, focus: state.focus === 'main' ? 'sidebar' : 'main' };
    case 'focus':
      return { ...state, focus: command.focus };
    case 'moveView': {
      const index = clamp(VIEWS.indexOf(state.view) + command.delta, 0, VIEWS.length - 1);
      return { ...state, view: VIEWS[index] as ViewId };
    }
    case 'move': {
      if (state.view === 'features' && state.featureId) {
        const tasks = ctx.taskCount ?? 0;
        return { ...state, taskCursor: tasks === 0 ? 0 : clamp(state.taskCursor + command.delta, 0, tasks - 1) };
      }
      const length = ctx.lengths[state.view] ?? 0;
      const next = length === 0 ? 0 : clamp(state.cursors[state.view] + command.delta, 0, length - 1);
      return { ...state, cursors: { ...state.cursors, [state.view]: next } };
    }
    case 'openHelp':
      // Rendered as a scrollable text view so it fits small terminals.
      return { ...state, overlay: { kind: 'text', title: 'Keyboard shortcuts', body: helpText(), scroll: 0 } };
    case 'closeOverlay':
      return { ...state, overlay: null };
    case 'openSwitcher':
      return { ...state, overlay: { kind: 'switcher', cursor: 0 } };
    case 'switcherMove':
      if (state.overlay?.kind !== 'switcher') return state;
      return {
        ...state,
        overlay: { ...state.overlay, cursor: clamp(state.overlay.cursor + command.delta, 0, Math.max(0, ctx.projectCount - 1)) },
      };
    case 'pickerMove':
      if (state.overlay?.kind !== 'picker') return state;
      return { ...state, overlay: { ...state.overlay, cursor: clamp(state.overlay.cursor + command.delta, 0, Math.max(0, state.overlay.options.length - 1)) } };
    case 'feature':
      if (command.action === 'close') return { ...state, featureId: null, taskCursor: 0 };
      return state;
    case 'scroll': {
      if (state.overlay?.kind !== 'text') return state;
      const max = Math.max(0, (ctx.textLines ?? 0) - (ctx.textHeight ?? 1));
      return { ...state, overlay: { ...state.overlay, scroll: clamp(state.overlay.scroll + command.delta, 0, max) } };
    }
    case 'inputChar':
      if (state.overlay?.kind !== 'input') return state;
      // Ignore control sequences; accept pasted text.
      return { ...state, overlay: { ...state.overlay, value: state.overlay.value + command.text.replace(/[\u0000-\u001f\u007f]/g, '') } };
    case 'inputBackspace':
      if (state.overlay?.kind !== 'input') return state;
      return { ...state, overlay: { ...state.overlay, value: state.overlay.value.slice(0, -1) } };
    default:
      return state;
  }
}

/** Clamp cursors after data changes (e.g. an agent disappeared). */
export function clampCursors(state: UiState, lengths: Partial<Record<ViewId, number>>): UiState {
  let changed = false;
  const cursors = { ...state.cursors };
  for (const view of VIEWS) {
    const length = lengths[view];
    if (length === undefined) continue;
    const value = length === 0 ? 0 : Math.min(cursors[view], length - 1);
    if (value !== cursors[view]) {
      cursors[view] = value;
      changed = true;
    }
  }
  return changed ? { ...state, cursors } : state;
}

export const HELP_SECTIONS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Navigation',
    keys: [
      ['tab', 'switch between sidebar and main panel'],
      ['↑ ↓ / j k', 'move selection'],
      ['1-7', 'jump to a view (Overview … Settings)'],
      ['p', 'project switcher'],
      ['a', 'agents view'],
      ['esc / ←', 'back to the sidebar, close dialogs'],
      ['?', 'this help'],
      ['q', 'quit (agents keep running)'],
    ],
  },
  {
    title: 'Agents (Agents / Overview)',
    keys: [
      ['+', 'new agent: name, provider and task, then it starts'],
      ['enter', 'details of the selected agent'],
      ['t', 'attach to its terminal (detach with Ctrl-b d to come back)'],
      ['s', 'start (spawn) the agent'],
      ['x', 'stop it (confirmation; worktree and branch are kept)'],
      ['r / R', 'restart in the same tmux session / restart and resume the conversation'],
      ['l', 'terminal output (logs)'],
      ['d', 'diff: commits, changed files, uncommitted changes'],
    ],
  },
  {
    title: 'Features (3) — describe, plan, approve, watch',
    keys: [
      ['n', 'new feature from anywhere: describe it like you would to Claude/Codex (files, context)'],
      ['enter', 'open the plan of the selected feature (esc goes back)'],
      ['A', 'approve the plan: agents start, the conductor validates and integrates'],
      ['f', 're-plan with your feedback'],
      ['c / e', 'change account / effort of the task (review); c on a running task switches account'],
      ['space', 'skip / restore a task (review)'],
      ['w', 'answer a blocked task (your text is typed into its agent)'],
      ['r / i', 'retry a task that needs you / integrate a validated task (confirm mode)'],
      ['t l d', 'attach to / logs of / diff of the task agent'],
      ['P / X / C', 'open the PR when ready / cancel the feature / clean up its worktrees'],
      ['v', 'full details: request, plan, routing reasons, events'],
    ],
  },
  {
    title: 'Accounts (5)',
    keys: [
      ['m', 'mark / unmark the account as limited (out of credits)'],
      ['L', 'log in to the account (runs the CLI login with its directory)'],
      ['E', 'edit settings.yaml: accounts and routing rules'],
      ['c', 'in Agents: continue the selected agent on another account (handoff)'],
    ],
  },
  {
    title: 'Projects',
    keys: [
      ['enter', 'select project'],
      ['+', 'register a repository (path input)'],
      ['-', 'forget project (repository untouched)'],
      ['I', 'initialize .agents/ in the selected project (any view)'],
      ['o', 'open a shell in the selected project, any view (type exit to return)'],
    ],
  },
  {
    title: 'Data',
    keys: [
      ['u', 'refresh now (auto-refresh every few seconds)'],
      ['g', 'refresh pull request status from GitHub (gh)'],
      ['n', 'new feature (natural-language request → plan)'],
    ],
  },
];

export function helpText(): string {
  const lines: string[] = [];
  for (const section of HELP_SECTIONS) {
    lines.push(`# ${section.title}`);
    for (const [k, d] of section.keys) lines.push(`  ${k.padEnd(12)} ${d}`);
    lines.push('');
  }
  lines.push('Closing Agent Workspace never stops agents: they keep running in tmux.');
  return lines.join('\n');
}
