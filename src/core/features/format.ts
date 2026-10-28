import { planWaves } from './plan.js';
import type { Feature, FeatureEvent, TaskState } from './store.js';

/** Plain-text views of features, shared by the CLI and the TUI. */

export const STATUS_LABEL: Record<Feature['status'], string> = {
  planning: 'planning…',
  'plan-failed': 'plan failed',
  review: 'plan ready: review',
  running: 'running',
  ready: 'ready for PR',
  'pr-open': 'PR open',
  done: 'done',
  cancelled: 'cancelled',
};

export const TASK_GLYPH: Record<TaskState['status'], string> = {
  pending: '⧗',
  running: '●',
  validating: '◌',
  validated: '◍',
  integrated: '✓',
  blocked: '?',
  attention: '!',
  skipped: '–',
};

export function taskStatusText(t: TaskState): string {
  switch (t.status) {
    case 'pending':
      return 'waiting';
    case 'validated':
      return 'validated, waiting to integrate';
    case 'blocked':
      return 'blocked: has a question';
    case 'attention':
      return 'needs you';
    default:
      return t.status;
  }
}

export function progress(f: Feature): { done: number; total: number; attention: number } {
  const live = f.tasks.filter((t) => t.status !== 'skipped');
  return {
    done: live.filter((t) => t.status === 'integrated').length,
    total: live.length,
    attention: live.filter((t) => t.status === 'blocked' || t.status === 'attention').length,
  };
}

/** One-line summary for lists and the sidebar. */
export function featureLine(f: Feature): string {
  const p = progress(f);
  const counts = f.tasks.length ? ` ${p.done}/${p.total}` : '';
  const attention = p.attention ? ` · ${p.attention} need you` : '';
  return `${STATUS_LABEL[f.status]}${f.status === 'running' ? counts : ''}${attention}`;
}

export interface Attention {
  feature: string;
  task: string | null;
  agent: string | null;
  kind: 'review' | 'question' | 'problem' | 'integrate' | 'ready' | 'plan-failed';
  text: string;
}

/** Everything that needs the human, across features. */
export function attentionItems(features: Feature[]): Attention[] {
  const out: Attention[] = [];
  for (const f of features) {
    if (f.status === 'review') out.push({ feature: f.id, task: null, agent: null, kind: 'review', text: `${f.title}: plan ready for review (${f.tasks.length} task(s))` });
    if (f.status === 'plan-failed') out.push({ feature: f.id, task: null, agent: null, kind: 'plan-failed', text: `${f.title}: planning failed — ${f.planner.error ?? ''}` });
    if (f.status === 'ready') out.push({ feature: f.id, task: null, agent: null, kind: 'ready', text: `${f.title}: all tasks integrated, open the PR` });
    for (const t of f.tasks) {
      if (t.status === 'blocked') out.push({ feature: f.id, task: t.id, agent: t.agent, kind: 'question', text: `${f.id}/${t.id} asks: ${t.attention ?? t.report?.summary ?? ''}` });
      if (t.status === 'attention') out.push({ feature: f.id, task: t.id, agent: t.agent, kind: 'problem', text: `${f.id}/${t.id}: ${t.attention ?? 'needs you'}` });
      if (t.status === 'validated' && f.integrate === 'confirm') out.push({ feature: f.id, task: t.id, agent: t.agent, kind: 'integrate', text: `${f.id}/${t.id}: validated, confirm integration` });
    }
  }
  return out;
}

export function featureText(f: Feature, events: FeatureEvent[] = []): string {
  const lines: string[] = [];
  lines.push(`${f.title}`, `id ${f.id} · ${STATUS_LABEL[f.status]} · branch ${f.branch} (from ${f.base}) · integration ${f.integrate}`);
  if (f.pr) lines.push(`Pull request #${f.pr.number} (${f.pr.state.toLowerCase()}) ${f.pr.url}`);
  lines.push('', '# Request', ...f.request.split('\n').map((l) => `  ${l}`));
  lines.push('', `# Planner`, `  ${f.planner.route.account} (${f.planner.route.provider}, effort ${f.planner.route.effort}) — ${f.planner.route.reason}`);
  if (f.planner.error) lines.push(`  ! ${f.planner.error}`);
  if (f.feedback.length) lines.push('  Feedback given:', ...f.feedback.map((x) => `   - ${x}`));
  if (f.plan) {
    lines.push('', '# Plan', `  ${f.plan.summary}`);
    if (f.plan.approach) lines.push(`  Approach: ${f.plan.approach}`);
    const waves = planWaves({ tasks: f.plan.tasks.filter((t) => f.tasks.find((s) => s.id === t.id)?.status !== 'skipped') });
    lines.push(`  Waves: ${waves.map((w, i) => `${i + 1}) ${w.join(' + ')}`).join('  ')}`);
    if (f.plan.questions.length) lines.push('', '# Open questions from the planner', ...f.plan.questions.map((q) => `  ? ${q}`));
    if (f.planWarnings.length) lines.push('', '# Warnings', ...f.planWarnings.map((w) => `  ! ${w}`));
    lines.push('', '# Tasks');
    for (const t of f.plan.tasks) {
      const s = f.tasks.find((x) => x.id === t.id);
      if (!s) continue;
      lines.push(
        `${TASK_GLYPH[s.status]} ${t.id} — ${t.title}   [${taskStatusText(s)}]`,
        `    agent ${s.agent} · ${s.route.account || '(no account)'} (${s.route.provider}${s.route.model ? ` ${s.route.model}` : ''}) · effort ${s.route.effort}`,
        `    why: ${s.route.reason}; complexity ${t.complexity}, risk ${t.risk} — ${t.rationale}`,
      );
      for (const w of s.route.warnings) lines.push(`    ! ${w}`);
      if (t.dependsOn.length) lines.push(`    after: ${t.dependsOn.join(', ')}`);
      lines.push(`    objective: ${t.objective.replace(/\s+/g, ' ')}`);
      if (t.scope.length) lines.push(`    scope: ${t.scope.join(', ')}`);
      if (t.validation.length) lines.push(`    validation: ${t.validation.join(' && ')}`);
      if (s.attention) lines.push(`    >> ${s.attention}`);
      if (s.report?.summary) lines.push(`    report: ${s.report.summary.replace(/\s+/g, ' ')}`);
      if (s.validation && !s.validation.ok) lines.push(`    last validation: ${s.validation.output.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
  if (events.length) {
    lines.push('', '# Recent events');
    for (const e of events.slice(-15)) lines.push(`  ${new Date(e.at).toLocaleTimeString()} ${e.task ? `[${e.task}] ` : ''}${e.text}`);
  }
  return lines.join('\n');
}
