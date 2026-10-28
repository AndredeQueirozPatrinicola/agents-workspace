import os from 'node:os';
import type { AgentView } from '../core/workspace/snapshot.js';

/** Display helpers for the TUI (pure). */

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '-';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}

export function pad(text: string, width: number): string {
  const t = truncate(text, width);
  return t + ' '.repeat(Math.max(0, width - t.length));
}

export function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function sessionText(agent: Pick<AgentView, 'session' | 'exitCode'>): string {
  switch (agent.session) {
    case 'running':
      return '● running';
    case 'exited':
      return agent.exitCode !== null ? `◐ exited (${agent.exitCode})` : '◐ exited';
    case 'stopped':
      return '○ stopped';
    case 'not-spawned':
      return '· not started';
  }
}

export function sessionColor(session: AgentView['session']): string | undefined {
  if (session === 'running') return 'green';
  if (session === 'exited') return 'yellow';
  return 'gray';
}

export function changesText(changes: AgentView['changes']): string {
  if (!changes) return '-';
  const parts: string[] = [];
  if (changes.conflicted) parts.push(`${changes.conflicted} conflicted`);
  if (changes.staged) parts.push(`${changes.staged} staged`);
  if (changes.unstaged) parts.push(`${changes.unstaged} modified`);
  if (changes.untracked) parts.push(`${changes.untracked} untracked`);
  return parts.length ? parts.join(', ') : 'clean';
}

export function aheadBehindText(ahead: number | null, behind: number | null): string {
  if (ahead === null || behind === null) return '-';
  return `↑${ahead} ↓${behind}`;
}

export function prText(pr: { number: number; state: string; isDraft?: boolean | undefined } | null | undefined): string {
  if (!pr) return '-';
  const state = pr.state === 'OPEN' ? (pr.isDraft ? 'draft' : 'open') : pr.state.toLowerCase();
  return `#${pr.number} ${state}`;
}

/** Window a list around the cursor so it fits in `height` rows. */
export function windowed<T>(items: T[], cursor: number, height: number): { start: number; items: T[] } {
  if (height <= 0) return { start: 0, items: [] };
  if (items.length <= height) return { start: 0, items };
  const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), items.length - height));
  return { start, items: items.slice(start, start + height) };
}
