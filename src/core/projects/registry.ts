import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { AwError, ExitCode } from '../errors.js';
import type { Git } from '../git/git.js';
import { CONFIG_DIR, CONFIG_FILE, configPathFor } from '../config/loader.js';
import { canonicalPath, pathExists, readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import { withLock } from '../../infrastructure/filesystem/lock.js';
import { logger } from '../../infrastructure/logger.js';

/**
 * Global project registry: the repositories Agent Workspace knows about on
 * this machine. Projects are referenced in place (never copied); the
 * identity of a project is its Git common directory, so the main worktree,
 * its subdirectories and every agent worktree resolve to the same project.
 *
 * Milestone 1 stores the registry as a versioned JSON file in the data
 * directory. Milestone 2 imports it into SQLite (see ADR 0001); callers only
 * depend on the `ProjectRegistry` interface.
 */

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Main working tree (or the worktree where .agents/ lives for bare layouts). */
  path: z.string(),
  commonDir: z.string(),
  registeredAt: z.string(),
  lastOpenedAt: z.string(),
});

const registrySchema = z.object({
  version: z.literal(1),
  projects: z.array(projectSchema),
});

export type ProjectRecord = z.infer<typeof projectSchema>;

export interface ProjectRegistry {
  readonly file: string;
  list(): Promise<ProjectRecord[]>;
  get(idOrName: string): Promise<ProjectRecord | undefined>;
  /** Register a Git repository by any path inside it. Idempotent. */
  register(anyPath: string): Promise<{ project: ProjectRecord; created: boolean }>;
  /** Find the registered project containing `anyPath` without registering it. */
  findContaining(anyPath: string): Promise<ProjectRecord | undefined>;
  touch(id: string): Promise<void>;
  /** Forget a project. Never touches the repository itself. */
  remove(id: string): Promise<boolean>;
}

export function projectIdFor(commonDir: string): string {
  return `prj_${createHash('sha1').update(canonicalPath(commonDir)).digest('hex').slice(0, 12)}`;
}

export class JsonProjectRegistry implements ProjectRegistry {
  private readonly lockFile: string;

  constructor(
    readonly file: string,
    private readonly git: Git,
  ) {
    this.lockFile = `${file}.lock`;
  }

  private async read(): Promise<ProjectRecord[]> {
    const text = await readTextIfExists(this.file);
    if (text === null) return [];
    try {
      return registrySchema.parse(JSON.parse(text)).projects;
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      await fsp.copyFile(this.file, backup).catch(() => undefined);
      logger.warn(`Project registry was unreadable and has been reset (backup: ${backup}).`);
      logger.debug(String(error));
      return [];
    }
  }

  private async update<T>(fn: (projects: ProjectRecord[]) => T | Promise<T>): Promise<T> {
    return withLock(this.lockFile, { purpose: 'registry update', waitMs: 5000, resource: 'Project registry' }, async () => {
      const projects = await this.read();
      const result = await fn(projects);
      await writeFileAtomic(this.file, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
      return result;
    });
  }

  async list(): Promise<ProjectRecord[]> {
    return (await this.read()).sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.name.localeCompare(b.name));
  }

  async get(idOrName: string): Promise<ProjectRecord | undefined> {
    const projects = await this.read();
    return (
      projects.find((p) => p.id === idOrName) ??
      projects.find((p) => p.name === idOrName) ??
      projects.find((p) => samePathSafe(p.path, idOrName))
    );
  }

  /** Resolve repository identity and the directory holding .agents/ for any path. */
  private async describe(anyPath: string): Promise<Omit<ProjectRecord, 'registeredAt' | 'lastOpenedAt'>> {
    const target = path.resolve(anyPath);
    if (!(await pathExists(target))) {
      throw new AwError(`Path not found: ${target}`, { exitCode: ExitCode.USAGE });
    }
    const repo = await this.git.detectRepository(target);
    const candidates = [repo.mainWorktree, repo.toplevel].filter((p): p is string => Boolean(p));
    let root = candidates[0];
    for (const candidate of candidates) {
      if (await pathExists(configPathFor(candidate))) {
        root = candidate;
        break;
      }
    }
    if (!root) {
      throw new AwError('Bare repositories cannot be registered directly.', {
        exitCode: ExitCode.USAGE,
        hint: 'Register one of its working trees instead.',
      });
    }
    return { id: projectIdFor(repo.commonDir), name: await projectName(root), path: root, commonDir: repo.commonDir };
  }

  async register(anyPath: string): Promise<{ project: ProjectRecord; created: boolean }> {
    const info = await this.describe(anyPath);
    return this.update((projects) => {
      const now = new Date().toISOString();
      const existing = projects.find((p) => p.id === info.id);
      if (existing) {
        Object.assign(existing, { name: info.name, path: info.path, commonDir: info.commonDir, lastOpenedAt: now });
        return { project: { ...existing }, created: false };
      }
      const project: ProjectRecord = { ...info, registeredAt: now, lastOpenedAt: now };
      projects.push(project);
      return { project: { ...project }, created: true };
    });
  }

  async findContaining(anyPath: string): Promise<ProjectRecord | undefined> {
    let commonDir: string;
    try {
      commonDir = (await this.git.detectRepository(path.resolve(anyPath))).commonDir;
    } catch {
      return undefined;
    }
    const id = projectIdFor(commonDir);
    return (await this.read()).find((p) => p.id === id);
  }

  async touch(id: string): Promise<void> {
    await this.update((projects) => {
      const project = projects.find((p) => p.id === id);
      if (project) project.lastOpenedAt = new Date().toISOString();
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.update((projects) => {
      const index = projects.findIndex((p) => p.id === id);
      if (index === -1) return false;
      projects.splice(index, 1);
      return true;
    });
  }
}

function samePathSafe(a: string, b: string): boolean {
  try {
    return canonicalPath(a) === canonicalPath(path.resolve(b));
  } catch {
    return false;
  }
}

/** Project name from .agents/workspace.yaml when present, else the directory name. */
async function projectName(root: string): Promise<string> {
  const text = await readTextIfExists(path.join(root, CONFIG_DIR, CONFIG_FILE));
  try {
    const name = (YAML.parse(text ?? '') as { project?: { name?: unknown } } | null)?.project?.name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch {
    /* invalid YAML: fall back to the directory name */
  }
  return path.basename(root);
}
