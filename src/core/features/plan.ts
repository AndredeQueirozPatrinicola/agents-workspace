import { z } from 'zod';
import { EFFORTS, LEVELS } from '../accounts/settings.js';
import { findDependencyCycle } from '../config/schema.js';
import { globToRegExp } from '../safety/safety.js';

/**
 * Execution plan produced by the planner (an agent CLI running read-only).
 *
 * The JSON schema handed to the CLIs is strict (every property required, no
 * additional properties), which both Codex (--output-schema) and Claude Code
 * (--json-schema) enforce. The zod schema re-validates the answer.
 */

export const TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
export const MAX_TASKS = 8;

export const planTaskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN, 'must be 1-16 lowercase letters, digits or "-", starting with a letter'),
  title: z.string().min(1).max(120),
  objective: z.string().min(1),
  context: z.string(),
  scope: z.array(z.string().min(1)),
  dependsOn: z.array(z.string()),
  acceptance: z.array(z.string().min(1)),
  validation: z.array(z.string().min(1)),
  complexity: z.enum(LEVELS),
  risk: z.enum(LEVELS),
  rationale: z.string(),
  suggestedProvider: z.enum(['codex', 'claude', 'any']),
  suggestedEffort: z.enum(EFFORTS),
});

export const planSchema = z.object({
  title: z.string().min(1).max(100),
  summary: z.string().min(1),
  approach: z.string(),
  questions: z.array(z.string()),
  tasks: z.array(planTaskSchema).min(1).max(MAX_TASKS),
});

export type Plan = z.infer<typeof planSchema>;
export type PlanTask = z.infer<typeof planTaskSchema>;

const str = { type: 'string' } as const;
const strArray = { type: 'array', items: { type: 'string' } } as const;

/** Strict JSON schema of the plan (for --output-schema / --json-schema). */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'approach', 'questions', 'tasks'],
  properties: {
    title: { type: 'string', description: 'Short feature title (max ~60 chars)' },
    summary: { type: 'string', description: 'What will be delivered, in 2-4 sentences' },
    approach: { type: 'string', description: 'Why the work is split this way (or why it is a single task)' },
    questions: { ...strArray, description: 'Open questions for the human; empty when none' },
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TASKS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'objective', 'context', 'scope', 'dependsOn', 'acceptance', 'validation', 'complexity', 'risk', 'rationale', 'suggestedProvider', 'suggestedEffort'],
        properties: {
          id: { type: 'string', description: 'kebab-case id, max 16 chars, e.g. "api" or "db-schema"' },
          title: str,
          objective: { type: 'string', description: 'The outcome, not the steps' },
          context: { type: 'string', description: 'Relevant files, conventions, contracts and decisions the agent must know' },
          scope: { ...strArray, description: 'Path globs this task is expected to modify' },
          dependsOn: { ...strArray, description: 'Ids of tasks that must be integrated first' },
          acceptance: { ...strArray, description: 'Observable, testable acceptance criteria' },
          validation: { ...strArray, description: 'Exact shell commands that verify the task (run from the repository root)' },
          complexity: { type: 'string', enum: [...LEVELS] },
          risk: { type: 'string', enum: [...LEVELS], description: 'high for auth, payments, data migrations, public contracts, security' },
          rationale: { type: 'string', description: 'Why this complexity/risk rating' },
          suggestedProvider: { type: 'string', enum: ['codex', 'claude', 'any'] },
          suggestedEffort: { type: 'string', enum: [...EFFORTS] },
        },
      },
    },
  },
};

export interface PlanCheck {
  errors: string[];
  warnings: string[];
}

/** Semantic checks the JSON schema cannot express. */
export function checkPlan(plan: Plan): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
  }
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) errors.push(`task "${t.id}" depends on itself`);
      else if (!ids.has(dep)) errors.push(`task "${t.id}" depends on unknown task "${dep}"`);
    }
    if (!t.validation.length) warnings.push(`task "${t.id}" has no validation commands: its "done" report is trusted as is`);
    if (!t.scope.length) warnings.push(`task "${t.id}" has no scope: overlaps with other tasks cannot be detected`);
  }
  const cycle = findDependencyCycle(Object.fromEntries(plan.tasks.map((t) => [t.id, { dependsOn: t.dependsOn }])));
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  // Tasks that can run at the same time should not edit the same files.
  const parallel = (a: PlanTask, b: PlanTask) => !dependsTransitively(plan, a.id, b.id) && !dependsTransitively(plan, b.id, a.id);
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i] as PlanTask;
      const b = plan.tasks[j] as PlanTask;
      if (!parallel(a, b)) continue;
      const overlap = a.scope.filter((g) => b.scope.some((h) => globsOverlap(g, h)));
      if (overlap.length) warnings.push(`tasks "${a.id}" and "${b.id}" run in parallel and both touch ${overlap.slice(0, 3).join(', ')}: expect merge conflicts`);
    }
  }
  return { errors, warnings };
}

function dependsTransitively(plan: Plan, from: string, to: string, seen = new Set<string>()): boolean {
  const task = plan.tasks.find((t) => t.id === from);
  if (!task || seen.has(from)) return false;
  seen.add(from);
  return task.dependsOn.includes(to) || task.dependsOn.some((d) => dependsTransitively(plan, d, to, seen));
}

/** Conservative glob overlap: identical, or one matches the other's literal prefix. */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const literal = (g: string) => g.split(/[*?[{]/)[0] ?? '';
  const la = literal(a);
  const lb = literal(b);
  if (globToRegExp(a).test(lb) || globToRegExp(b).test(la)) return true;
  return la.length > 0 && lb.length > 0 && (la.startsWith(lb) || lb.startsWith(la)) && (a.includes('*') || b.includes('*'));
}

/** Waves of tasks that can run in parallel (for display). */
export function planWaves(plan: Pick<Plan, 'tasks'>): string[][] {
  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = plan.tasks.map((t) => t.id);
  while (remaining.length) {
    const wave = remaining.filter((id) => plan.tasks.find((t) => t.id === id)?.dependsOn.every((d) => done.has(d)));
    if (!wave.length) break; // cycle: checkPlan reports it
    waves.push(wave);
    for (const id of wave) done.add(id);
    remaining = remaining.filter((id) => !done.has(id));
  }
  return waves;
}

/** Task file given to the agent (Markdown, same sections as hand-written tasks). */
export function renderPlanTask(task: PlanTask, feature: { title: string; summary: string; request: string }): string {
  const lines = [`# Task: ${task.title}`, '', `Part of the feature "${feature.title}": ${feature.summary}`, '', '## Objective', '', task.objective.trim(), ''];
  if (task.context.trim()) lines.push('## Technical Context', '', task.context.trim(), '');
  if (task.scope.length) lines.push('## Files', '', ...task.scope.map((g) => `- \`${g}\``), '');
  lines.push('## Acceptance Criteria', '', ...(task.acceptance.length ? task.acceptance : ['The objective above is implemented and covered by tests.']).map((a) => `- ${a}`), '');
  if (task.validation.length) lines.push('## Validation', '', 'Run from the repository root:', '', '```sh', ...task.validation, '```', '');
  lines.push('## Original request', '', ...feature.request.trim().split('\n').map((l) => `> ${l}`), '');
  return lines.join('\n');
}
