import { describe, expect, it } from 'vitest';
import { clampCursors, initialUiState, interpretKey, reduce, type Command, type UiState } from '../src/tui/state.js';
import { aheadBehindText, changesText, prText, relativeTime, sessionText, truncate, windowed } from '../src/tui/format.js';

const ctx = { lengths: { agents: 3, projects: 2, overview: 3, activity: 0 }, projectCount: 2 };

function press(state: UiState, input: string, key: Record<string, boolean> = {}): { state: UiState; command: Command } {
  const command = interpretKey(state, input, key);
  return { state: reduce(state, command, ctx), command };
}

describe('TUI navigation state', () => {
  it('maps the documented global shortcuts', () => {
    const s = initialUiState('prj_1');
    expect(interpretKey(s, 'q', {})).toEqual({ type: 'quit' });
    expect(interpretKey(s, '?', {})).toEqual({ type: 'openHelp' });
    expect(interpretKey(s, 'p', {})).toEqual({ type: 'openSwitcher' });
    expect(interpretKey(s, 'a', {})).toEqual({ type: 'setView', view: 'agents' });
    expect(interpretKey(s, 'n', {})).toEqual({ type: 'newFeature' });
    expect(interpretKey(s, '', { tab: true })).toEqual({ type: 'toggleFocus' });
    expect(interpretKey(s, '7', {})).toEqual({ type: 'setView', view: 'settings' });
    expect(interpretKey(s, 'c', { ctrl: true })).toEqual({ type: 'quit' });
  });

  it('moves between views in the sidebar and between rows in the main panel (clamped)', () => {
    let s = initialUiState();
    s = press(s, '', { tab: true }).state;
    expect(s.focus).toBe('sidebar');
    s = press(s, 'j').state;
    s = press(s, '', { downArrow: true }).state;
    expect(s.view).toBe('features');
    for (let i = 0; i < 10; i++) s = press(s, 'j').state;
    expect(s.view).toBe('settings');
    s = press(s, '', { return: true }).state;
    expect(s.focus).toBe('main');

    s = press(s, '4').state; // agents
    for (let i = 0; i < 5; i++) s = press(s, 'j').state;
    expect(s.cursors.agents).toBe(2);
    s = press(s, 'k').state;
    expect(s.cursors.agents).toBe(1);
    expect(press(s, '', { escape: true }).state.focus).toBe('sidebar');
  });

  it('routes agent and project actions by view', () => {
    const agents = { ...initialUiState(), view: 'agents' as const };
    expect(interpretKey(agents, 't', {})).toEqual({ type: 'agent', action: 'attach' });
    expect(interpretKey(agents, 'x', {})).toEqual({ type: 'agent', action: 'stop' });
    expect(interpretKey(agents, 'r', {})).toEqual({ type: 'agent', action: 'restart' });
    expect(interpretKey(agents, 'R', {})).toEqual({ type: 'agent', action: 'resume' });
    expect(interpretKey(agents, 'l', {})).toEqual({ type: 'agent', action: 'logs' });
    expect(interpretKey(agents, 'd', {})).toEqual({ type: 'agent', action: 'diff' });
    expect(interpretKey(agents, '', { return: true })).toEqual({ type: 'agent', action: 'details' });
    const projects = { ...initialUiState(), view: 'projects' as const };
    expect(interpretKey(projects, '+', {})).toEqual({ type: 'project', action: 'register' });
    expect(interpretKey(projects, '-', {})).toEqual({ type: 'project', action: 'forget' });
    expect(interpretKey(projects, 'I', {})).toEqual({ type: 'project', action: 'init' });
    expect(interpretKey(initialUiState(), 'I', {})).toEqual({ type: 'project', action: 'init' }); // any view
    expect(interpretKey(agents, '+', {})).toEqual({ type: 'agent', action: 'create' });
    expect(interpretKey(projects, '', { return: true })).toEqual({ type: 'project', action: 'select' });
    // Agent keys do nothing outside agent views.
    expect(interpretKey({ ...initialUiState(), view: 'settings' }, 'x', {})).toEqual({ type: 'none' });
    // Features: list vs plan view.
    const features = { ...initialUiState(), view: 'features' as const };
    expect(interpretKey(features, '', { return: true })).toEqual({ type: 'feature', action: 'open' });
    const plan = { ...features, featureId: 'f1' };
    expect(interpretKey(plan, 'A', {})).toEqual({ type: 'feature', action: 'approve' });
    expect(interpretKey(plan, ' ', {})).toEqual({ type: 'feature', action: 'skip' });
    expect(interpretKey(plan, 'c', {})).toEqual({ type: 'feature', action: 'account' });
    expect(interpretKey(plan, '', { escape: true })).toEqual({ type: 'feature', action: 'close' });
    expect(reduce(plan, { type: 'feature', action: 'close' }, ctx).featureId).toBeNull();
    let moved = reduce(plan, { type: 'move', delta: 5 }, { ...ctx, taskCount: 3 });
    expect(moved.taskCursor).toBe(2);
    moved = reduce(moved, { type: 'move', delta: -1 }, { ...ctx, taskCount: 3 });
    expect(moved.taskCursor).toBe(1);
    expect(interpretKey({ ...initialUiState(), view: 'agents' }, 'c', {})).toEqual({ type: 'agent', action: 'account' });
    expect(interpretKey({ ...initialUiState(), view: 'accounts' }, 'm', {})).toEqual({ type: 'account', action: 'limit' });
  });

  it('captures keys while a dialog is open', () => {
    let s: UiState = { ...initialUiState(), overlay: { kind: 'confirm', title: 't', message: 'm', pending: { kind: 'agent', action: 'stop', projectId: 'p', target: 'a' } } };
    expect(interpretKey(s, 'q', {})).toEqual({ type: 'confirm', yes: false });
    expect(interpretKey(s, 'y', {})).toEqual({ type: 'confirm', yes: true });
    expect(interpretKey(s, 'x', {})).toEqual({ type: 'none' });

    s = { ...initialUiState(), overlay: { kind: 'input', title: 'Path', value: '', purpose: 'register' } };
    s = press(s, '~/projects/app').state;
    s = press(s, 'x').state; // 'x' is text here, not "stop"
    s = press(s, '', { backspace: true }).state;
    s = press(s, 'q').state; // 'q' types, it does not quit
    expect(s.overlay).toMatchObject({ kind: 'input', value: '~/projects/appq' });
    expect(interpretKey(s, '', { return: true })).toEqual({ type: 'inputSubmit' });
    expect(press(s, '', { escape: true }).state.overlay).toBeNull();
  });

  it('opens help as a scrollable view and clamps scrolling', () => {
    let s = press(initialUiState(), '?').state;
    expect(s.overlay).toMatchObject({ kind: 'text', title: 'Keyboard shortcuts' });
    const body = s.overlay?.kind === 'text' ? s.overlay.body : '';
    expect(body).toContain('never stops agents');
    const lines = body.split('\n').length;
    s = reduce(s, { type: 'scroll', delta: 1000 }, { ...ctx, textLines: lines, textHeight: 10 });
    expect(s.overlay?.kind === 'text' && s.overlay.scroll).toBe(lines - 10);
    s = reduce(s, { type: 'scroll', delta: -1000 }, { ...ctx, textLines: lines, textHeight: 10 });
    expect(s.overlay?.kind === 'text' && s.overlay.scroll).toBe(0);
    expect(interpretKey(s, '?', {})).toEqual({ type: 'closeOverlay' });
  });

  it('keeps the project switcher cursor in range and clamps cursors when data shrinks', () => {
    let s = press(initialUiState(), 'p').state;
    for (let i = 0; i < 5; i++) s = press(s, 'j').state;
    expect(s.overlay).toMatchObject({ kind: 'switcher', cursor: 1 });
    const t = clampCursors({ ...initialUiState(), cursors: { ...initialUiState().cursors, agents: 4 } }, { agents: 2 });
    expect(t.cursors.agents).toBe(1);
  });
});

describe('TUI formatting', () => {
  it('formats times, sizes and states', () => {
    const now = new Date('2026-10-28T12:00:00Z');
    expect(relativeTime('2026-10-28T11:59:30Z', now)).toBe('30s ago');
    expect(relativeTime('2026-10-28T11:00:00Z', now)).toBe('1h ago');
    expect(relativeTime(null, now)).toBe('-');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(windowed([1, 2, 3, 4, 5, 6], 5, 3)).toEqual({ start: 3, items: [4, 5, 6] });
    expect(sessionText({ session: 'exited', exitCode: 1 })).toBe('◐ exited (1)');
    expect(changesText({ staged: 1, unstaged: 0, untracked: 2, conflicted: 0 })).toBe('1 staged, 2 untracked');
    expect(aheadBehindText(2, 0)).toBe('↑2 ↓0');
    expect(prText({ number: 7, state: 'OPEN', isDraft: true })).toBe('#7 draft');
  });
});
