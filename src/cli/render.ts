import type { AgentStatus } from '../core/agents/service.js';
import { sessionLabel } from '../core/agents/service.js';
import type { CheckReport } from '../core/safety/check.js';
import type { DoctorCheck } from '../core/workspace/doctor.js';
import type { PrStatusRow } from '../core/github/pr-service.js';
import { displayPath } from '../infrastructure/filesystem/fs.js';
import { colors as c, padVisible, symbols, table } from '../infrastructure/terminal/ui.js';

/** Pure rendering helpers for human-readable command output. */

export function formatChanges(changes: AgentStatus['changes']): string {
  if (!changes) return c.dim('-');
  const parts: string[] = [];
  if (changes.conflicted) parts.push(c.red(`${changes.conflicted} conflicted`));
  if (changes.staged) parts.push(`${changes.staged} staged`);
  if (changes.unstaged) parts.push(`${changes.unstaged} modified`);
  if (changes.untracked) parts.push(`${changes.untracked} untracked`);
  return parts.length ? c.yellow(parts.join(', ')) : c.dim('clean');
}

export function formatAheadBehind(row: Pick<AgentStatus, 'ahead' | 'behind'>): string {
  if (row.ahead === null || row.behind === null) return c.dim('-');
  const behind = row.behind > 0 ? c.yellow(`${symbols.arrowDown}${row.behind}`) : `${symbols.arrowDown}0`;
  return `${symbols.arrowUp}${row.ahead} ${behind}`;
}

export function formatPr(pr: AgentStatus['pr']): string | null {
  if (!pr) return null;
  const state = pr.state.toLowerCase() + (pr.isDraft && pr.state === 'OPEN' ? ', draft' : '');
  return `#${pr.number} ${state}  ${pr.url}`;
}

export function renderStatus(
  header: { project: string; base: string; workspaceDir: string; warnings: string[] },
  rows: AgentStatus[],
): string {
  const out: string[] = [];
  out.push(`${c.bold('Agent Workspace')} ${c.dim('·')} ${header.project} ${c.dim(`(base: ${header.base})`)}`);
  out.push(c.dim(`Worktrees: ${displayPath(header.workspaceDir)}`));
  for (const w of header.warnings) out.push(`${c.yellow(symbols.warn)} ${w}`);
  out.push('');
  if (rows.length === 0) {
    out.push('No agents configured yet.');
    out.push(c.dim('Add one with: aw spawn <agent> --provider codex|claude'));
    return out.join('\n');
  }
  const nameWidth = Math.max(...rows.map((r) => r.name.length), 5);
  const providerWidth = Math.max(...rows.map((r) => r.provider.length), 6);
  for (const row of rows) {
    const session = row.session === 'exited' && row.exitCode !== null ? `${sessionLabel(row.session)} (${row.exitCode})` : sessionLabel(row.session);
    out.push(
      [
        c.bold(padVisible(row.name, nameWidth)),
        padVisible(row.provider, providerWidth),
        padVisible(session, 16),
        padVisible(row.branch, 24),
        padVisible(formatAheadBehind(row), 9),
        formatChanges(row.changes),
      ].join('  '),
    );
    const label = (k: string) => `  ${c.dim(k.padEnd(5))} `;
    const taskTitle = row.task.title ?? row.description ?? (row.task.exists ? '(untitled)' : c.dim('(no task file)'));
    out.push(`${label('task')}${taskTitle}${row.task.template ? c.yellow(' [template]') : ''}  ${c.dim(`(${row.task.path})`)}`);
    if (row.worktreePath) {
      out.push(`${label('path')}${displayPath(row.worktreePath)}${row.worktreeExists ? '' : c.red(' (missing)')}`);
    }
    if (row.dependsOn.length) {
      out.push(`${label('deps')}${row.dependsOn.map((d) => `${d.name} (${d.state.replace('-', ' ')})`).join(', ')}`);
    }
    const pr = formatPr(row.pr);
    if (pr) out.push(`${label('pr')}${pr}`);
    if (!row.configured) out.push(`${label('note')}${c.yellow('not in workspace.yaml (runtime state only)')}`);
    out.push('');
  }
  const running = rows.filter((r) => r.session === 'running').length;
  out.push(c.dim(`${rows.length} agent(s), ${running} running.  aw attach <agent> · aw dashboard · aw check`));
  return out.join('\n');
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: c.green(symbols.ok), warn: c.yellow(symbols.warn), fail: c.red(symbols.fail) };
  const width = Math.max(...checks.map((ch) => ch.name.length));
  const lines = checks.map((ch) => {
    const line = `${icon[ch.status]} ${ch.name.padEnd(width)}  ${ch.detail}`;
    return ch.hint && ch.status !== 'ok' ? `${line}\n  ${' '.repeat(width)}  ${c.dim(ch.hint)}` : line;
  });
  return [c.bold('Agent Workspace doctor'), '', ...lines].join('\n');
}

export function renderCheck(report: CheckReport): string {
  const out: string[] = [c.bold('Parallel development check'), ''];
  if (!report.mergeSimulation) out.push(c.yellow(`${symbols.warn} Git < 2.38: conflict simulation is unavailable; only file overlaps are reported.`));
  out.push(c.dim(`Branches checked: ${report.agentsChecked.join(', ') || 'none'}`), '');
  if (report.issues.length === 0) {
    out.push(`${c.green(symbols.ok)} No overlaps, conflicts or stale branches detected.`);
    return out.join('\n');
  }
  const icon = { error: c.red(symbols.fail), warning: c.yellow(symbols.warn), info: c.dim(symbols.info) };
  for (const issue of report.issues) {
    out.push(`${icon[issue.level]} ${issue.message}`);
    for (const d of issue.details) out.push(`    ${c.dim(d)}`);
  }
  out.push('');
  out.push(c.dim('Nothing was changed. Resolve conflicts manually; Agent Workspace never merges or rebases for you.'));
  return out.join('\n');
}

export function renderPrStatus(rows: PrStatusRow[]): string {
  if (rows.length === 0) return 'No agents.';
  const body = rows.map((r) => {
    if (r.error) return [r.agent, r.branch, c.red('error'), '', '', r.error];
    if (!r.pr) return [r.agent, r.branch, c.dim('no PR'), '', '', ''];
    const p = r.pr;
    const state = p.state === 'OPEN' ? (p.isDraft ? c.yellow('draft') : c.green('open')) : p.state === 'MERGED' ? c.cyan('merged') : c.dim(p.state.toLowerCase());
    const ck = p.checks;
    const checks = ck.total === 0 ? c.dim('none') : `${ck.passing}/${ck.total} passing${ck.failing ? c.red(`, ${ck.failing} failing`) : ''}${ck.pending ? c.yellow(`, ${ck.pending} pending`) : ''}`;
    const review = p.reviewDecision ? p.reviewDecision.toLowerCase().replace(/_/g, ' ') : '';
    return [r.agent, r.branch, `#${p.number} ${state}`, checks, review, p.url];
  });
  return table(['AGENT', 'BRANCH', 'PR', 'CHECKS', 'REVIEW', 'URL'], body);
}
