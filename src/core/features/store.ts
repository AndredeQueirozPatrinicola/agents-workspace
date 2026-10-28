import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { AwError, ExitCode } from '../errors.js';
import { planSchema } from './plan.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { ensureDir, readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import { withLock } from '../../infrastructure/filesystem/lock.js';

/**
 * Features: one natural-language request → plan → tasks → feature branch.
 *
 * Machine-local runtime data next to the agent state, never committed:
 *
 *   <git-common-dir>/agent-workspace/features/<id>/
 *     feature.json     request, plan, routing, task progress
 *     events.jsonl     append-only history (shown in the dashboard)
 *     tasks/<task>.md  task files handed to the agents
 *     planner/         planner prompt, schema, raw output and log
 *     pr.md            title/body used for the feature's pull request
 */

export const FEATURE_STATUSES = ['planning', 'plan-failed', 'review', 'running', 'ready', 'pr-open', 'done', 'cancelled'] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

export const TASK_STATUSES = [
  'pending', // waiting for dependencies or a free slot
  'running', // agent working
  'validating', // agent reported done, validation running
  'validated', // waiting for integration confirmation (features.integrate: confirm)
  'integrated', // merged into the feature branch
  'blocked', // agent asked a question
  'attention', // needs the human (exited, failed twice, usage limit, …)
  'skipped', // removed by the human
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses in which the conductor keeps working on a feature. */
export const ACTIVE_FEATURE_STATUSES: readonly FeatureStatus[] = ['running'];

const routeSchema = z.object({
  account: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  effort: z.string(),
  reason: z.string(),
  warnings: z.array(z.string()).default([]),
});

const reportSchema = z.object({
  status: z.enum(['done', 'blocked']),
  summary: z.string().default(''),
  questions: z.array(z.string()).default([]),
  at: z.string(),
});

const taskStateSchema = z.object({
  id: z.string(),
  agent: z.string(),
  status: z.enum(TASK_STATUSES),
  route: routeSchema,
  /** Validation attempts after a "done" report. */
  attempts: z.number().default(0),
  /** Integration conflicts handed back to the agent. */
  conflicts: z.number().default(0),
  report: reportSchema.nullable().default(null),
  validation: z.object({ ok: z.boolean(), output: z.string(), at: z.string() }).nullable().default(null),
  attention: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  integratedAt: z.string().nullable().default(null),
  /** Outcome data for routing statistics. */
  firstPass: z.boolean().nullable().default(null),
  /** Commit that passed validation (only this commit is integrated). */
  validatedSha: z.string().nullable().default(null),
  /** Usage-limit line already acted upon (so the same screen text is not reported twice). */
  limitSeen: z.string().nullable().default(null),
});

export const featureSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string(),
  request: z.string(),
  status: z.enum(FEATURE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  base: z.string(),
  branch: z.string(),
  planner: z.object({
    route: routeSchema,
    startedAt: z.string().nullable().default(null),
    finishedAt: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
  }),
  feedback: z.array(z.string()).default([]),
  plan: planSchema.nullable().default(null),
  planWarnings: z.array(z.string()).default([]),
  tasks: z.array(taskStateSchema).default([]),
  /** Validated tasks may be merged automatically or wait for the human. */
  integrate: z.enum(['auto', 'confirm']).default('auto'),
  pr: z.object({ number: z.number(), url: z.string(), state: z.string() }).nullable().default(null),
});

export type Feature = z.infer<typeof featureSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type Route = z.infer<typeof routeSchema>;
export type TaskReport = z.infer<typeof reportSchema>;

export interface FeatureEvent {
  at: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  task?: string | undefined;
  text: string;
}

export const FEATURE_ID_MAX = 14;

export function slugify(text: string, max = FEATURE_ID_MAX): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, max).replace(/-+$/g, '');
  if (!cut) return 'feature';
  return /^[a-z]/.test(cut) ? cut : `f-${cut}`.slice(0, max).replace(/-+$/g, '');
}

export class FeatureStore {
  readonly root: string;
  constructor(stateDir: string) {
    this.root = path.join(stateDir, 'features');
  }

  dir(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) throw new AwError(`Invalid feature id "${id}".`, { exitCode: ExitCode.USAGE });
    return path.join(this.root, id);
  }
  file(id: string): string {
    return path.join(this.dir(id), 'feature.json');
  }
  taskFile(id: string, task: string): string {
    return path.join(this.dir(id), 'tasks', `${task}.md`);
  }
  plannerDir(id: string): string {
    return path.join(this.dir(id), 'planner');
  }
  prFile(id: string): string {
    return path.join(this.dir(id), 'pr.md');
  }
  private lockFile(id: string): string {
    return path.join(this.dir(id), 'feature.lock');
  }
  /** Lock held by whoever advances a feature (conductor or CLI). */
  advanceLock(id: string): string {
    return path.join(this.dir(id), 'advance.lock');
  }

  async ids(): Promise<string[]> {
    const entries = await fsp.readdir(this.root, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  }

  async get(id: string): Promise<Feature | null> {
    const text = await readTextIfExists(this.file(id));
    if (!text) return null;
    const parsed = featureSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  }

  async require(id: string): Promise<Feature> {
    const feature = await this.get(id);
    if (!feature) throw new AwError(`Unknown feature "${id}".`, { exitCode: ExitCode.USAGE, hint: 'List features with: aw feature list' });
    return feature;
  }

  async list(): Promise<Feature[]> {
    const out: Feature[] = [];
    for (const id of await this.ids()) {
      const f = await this.get(id).catch(() => null);
      if (f) out.push(f);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A free id derived from a title (never colliding with existing features or names in `taken`). */
  async freeId(title: string, taken: Set<string>): Promise<string> {
    const base = slugify(title);
    const existing = new Set([...(await this.ids()), ...taken]);
    if (!existing.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base.slice(0, FEATURE_ID_MAX - String(i).length - 1).replace(/-+$/g, '')}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new AwError('Could not find a free feature id.');
  }

  async create(feature: Feature): Promise<void> {
    await ensureDir(this.dir(feature.id));
    await writeFileAtomic(this.file(feature.id), `${JSON.stringify(feature, null, 2)}\n`);
  }

  /** Atomically read, modify and write a feature. */
  async update(id: string, fn: (f: Feature) => void | Promise<void>): Promise<Feature> {
    return withLock(this.lockFile(id), { purpose: 'feature update', waitMs: 5000, resource: `Feature "${id}"` }, async () => {
      const feature = await this.require(id);
      await fn(feature);
      feature.updatedAt = new Date().toISOString();
      featureSchema.parse(feature);
      await writeFileAtomic(this.file(id), `${JSON.stringify(feature, null, 2)}\n`);
      return feature;
    });
  }

  event(id: string, event: Omit<FeatureEvent, 'at'>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    try {
      mkdirSync(this.dir(id), { recursive: true });
      appendFileSync(path.join(this.dir(id), 'events.jsonl'), `${line}\n`);
    } catch {
      /* history is best effort */
    }
  }

  async events(id: string, limit = 200): Promise<FeatureEvent[]> {
    const text = (await readTextIfExists(path.join(this.dir(id), 'events.jsonl'))) ?? '';
    const lines = text.split('\n').filter(Boolean).slice(-limit);
    const out: FeatureEvent[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as FeatureEvent);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

/** Agent name of a feature task. */
export function taskAgentName(featureId: string, taskId: string): string {
  return `${featureId}-${taskId}`.slice(0, 32).replace(/-+$/g, '');
}
