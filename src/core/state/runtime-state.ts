import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import { withLock } from '../../infrastructure/filesystem/lock.js';
import { logger } from '../../infrastructure/logger.js';

/**
 * Machine-specific runtime state.
 *
 * Stored inside the repository's common Git directory
 * (`<git-common-dir>/agent-workspace/`), which means it is:
 *  - shared by all worktrees of the repository,
 *  - never committed or pushed,
 *  - naturally scoped to this clone on this machine.
 *
 * Layout:
 *   state.json            agents, worktree paths, session names, PR cache
 *   state.lock            short-lived lock for read-modify-write cycles
 *   agents/<name>/        launch script, prompt, exit status, agent lock
 */

export const STATE_DIR_NAME = 'agent-workspace';
export const WORKTREE_MARKER_FILE = 'agent-workspace.json';

const prSchema = z.object({
  number: z.number(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  updatedAt: z.string(),
});

const agentRecordSchema = z.object({
  name: z.string(),
  provider: z.string(),
  branch: z.string(),
  base: z.string(),
  worktreePath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  session: z
    .object({
      backend: z.literal('tmux'),
      name: z.string(),
      startedAt: z.string(),
    })
    .optional(),
  lastLaunch: z
    .object({
      at: z.string(),
      command: z.array(z.string()),
      resumed: z.boolean(),
    })
    .optional(),
  pr: prSchema.optional(),
});

const stateSchema = z.object({
  version: z.literal(1),
  configRoot: z.string().optional(),
  agents: z.record(z.string(), agentRecordSchema),
  /** Last known PR per agent; kept after cleanup so dependency states survive. */
  prs: z.record(z.string(), prSchema).optional(),
});

export type AgentRecord = z.infer<typeof agentRecordSchema>;
export type RuntimeState = z.infer<typeof stateSchema>;
export type PrRecord = z.infer<typeof prSchema>;

export function emptyState(): RuntimeState {
  return { version: 1, agents: {} };
}

export class StateStore {
  readonly dir: string;
  readonly file: string;
  private readonly lockFile: string;

  constructor(commonDir: string) {
    this.dir = path.join(commonDir, STATE_DIR_NAME);
    this.file = path.join(this.dir, 'state.json');
    this.lockFile = path.join(this.dir, 'state.lock');
  }

  agentDir(name: string): string {
    return path.join(this.dir, 'agents', name);
  }

  agentLockFile(name: string): string {
    return path.join(this.agentDir(name), 'agent.lock');
  }

  async load(): Promise<RuntimeState> {
    const text = await readTextIfExists(this.file);
    if (text === null) return emptyState();
    try {
      return stateSchema.parse(JSON.parse(text));
    } catch (error) {
      // Corrupt state must never block the user: keep a backup and start fresh.
      // Worktrees can be re-adopted with `aw repair` (they carry a marker file).
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fsp.copyFile(this.file, backup).catch(() => undefined);
      logger.warn(`Runtime state was unreadable and has been reset (backup: ${backup}). Run "aw repair" to re-adopt worktrees.`);
      logger.debug(String(error));
      return emptyState();
    }
  }

  /** Atomically read, modify and write the state under a lock. */
  async update<T>(fn: (state: RuntimeState) => T | Promise<T>): Promise<T> {
    return withLock(this.lockFile, { purpose: 'state update', waitMs: 5000, resource: 'Runtime state' }, async () => {
      const state = await this.load();
      const result = await fn(state);
      await writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return result;
    });
  }

  async getAgent(name: string): Promise<AgentRecord | undefined> {
    return (await this.load()).agents[name];
  }

  async upsertAgent(record: AgentRecord): Promise<void> {
    await this.update((state) => {
      state.agents[record.name] = record;
    });
  }

  async patchAgent(name: string, patch: Partial<AgentRecord>): Promise<void> {
    await this.update((state) => {
      const existing = state.agents[name];
      if (!existing) return;
      state.agents[name] = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    });
  }

  async recordPr(name: string, pr: PrRecord): Promise<void> {
    await this.update((state) => {
      state.prs = { ...(state.prs ?? {}), [name]: pr };
      const record = state.agents[name];
      if (record) state.agents[name] = { ...record, pr, updatedAt: new Date().toISOString() };
    });
  }

  async removeAgent(name: string): Promise<void> {
    await this.update((state) => {
      delete state.agents[name];
    });
    await fsp.rm(this.agentDir(name), { recursive: true, force: true });
  }
}
