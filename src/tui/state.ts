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

export type AgentAction = 'attach' | 'start' | 'stop' | 'restart' | 'resume' | 'logs' | 'diff' | 'details';
export type ProjectAction = 'select' | 'register' | 'forget' | 'init' | 'shell';

/** Actions that need a confirmation before running. */
export interface PendingAction {
  kind: 'agent' | 'project';
  action: AgentAction | ProjectAction;
  projectId: string;
  target: string;
}

export type Overlay =
  | { kind: 'help' }
  | { kind: 'confirm'; title: string; message: string; pending: PendingAction }
  | { kind: 'text'; title: string; body: string; scroll: number }
  | { kind: 'input'; title: string; value: string; purpose: 'register' }
  | { kind: 'switcher'; cursor: number };

export interface Flash {
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface UiState {
  view: ViewId;
  focus: 'sidebar' | 'main';
  projectId: string | null;
  cursors: Record<ViewId, number>;
  overlay: Overlay | null;
  flash: Flash | null;
}

export function initialUiState(projectId: string | null = null): UiState {
  return {
    view: 'overview',
    focus: 'main',
    projectId,
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
  if (key.escape || key.leftArrow) return { type: 'focus', focus: 'sidebar' };
  if (key.downArrow || input === 'j') return { type: 'move', delta: 1 };
  if (key.upArrow || input === 'k') return { type: 'move', delta: -1 };
  if (key.pageDown) return { type: 'move', delta: 10 };
  if (key.pageUp) return { type: 'move', delta: -10 };

  if (state.view === 'agents' || state.view === 'overview') {
    if (key.return) return { type: 'agent', action: 'details' };
    if (input === 't') return { type: 'agent', action: 'attach' };
    if (input === 's') return { type: 'agent', action: 'start' };
    if (input === 'x') return { type: 'agent', action: 'stop' };
    if (input === 'r') return { type: 'agent', action: 'restart' };
    if (input === 'R') return { type: 'agent', action: 'resume' };
    if (input === 'l') return { type: 'agent', action: 'logs' };
    if (input === 'd') return { type: 'agent', action: 'diff' };
  }
  if (state.view === 'projects') {
    if (key.return) return { type: 'project', action: 'select' };
    if (input === '+' || input === 'i') return { type: 'project', action: 'register' };
    if (input === '-' || input === 'x') return { type: 'project', action: 'forget' };
    if (input === 'I') return { type: 'project', action: 'init' };
  }
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
    title: 'Projects',
    keys: [
      ['enter', 'select project'],
      ['+', 'register a repository (path input)'],
      ['-', 'forget project (repository untouched)'],
      ['I', 'initialize .agents/ in a registered repository'],
      ['o', 'open a shell in the selected project (exit to return)'],
    ],
  },
  {
    title: 'Data',
    keys: [
      ['u', 'refresh now (auto-refresh every few seconds)'],
      ['g', 'refresh pull request status from GitHub (gh)'],
      ['n', 'new feature (natural-language planning: Milestone 3)'],
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
