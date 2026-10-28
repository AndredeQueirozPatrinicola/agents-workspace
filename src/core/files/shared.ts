import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import type { Git } from '../git/git.js';
import { globToRegExp } from '../safety/safety.js';
import { ensureDir, pathExists, readTextIfExists, writeFileAtomic, writeFileExclusive } from '../../infrastructure/filesystem/fs.js';

/**
 * Files that are not code:
 *
 * 1. The **shared files area**, `<workspace dir>/.shared/`, outside every
 *    repository and worktree, so nothing in it can be committed by accident:
 *
 *      .shared/inbox/              inputs for all agents (specs, designs, data)
 *      .shared/inbox/<agent>/      inputs for one agent
 *      .shared/outbox/<agent>/     non-code deliverables from one agent
 *
 *    It is passed to the agent CLIs with `--add-dir`, so their sandboxes allow
 *    reading and writing there, and its paths are part of the agent prompt.
 *
 * 2. **Local files** (`workspace.copyFiles`): uncommitted, git-ignored files
 *    such as `.env` that a fresh worktree lacks. They are copied from the main
 *    worktree on spawn (never overwriting) and remembered with a hash, so
 *    `aw cleanup` can delete unchanged copies without asking.
 */

export interface SharedPaths {
  root: string;
  inbox: string;
  agentInbox: string;
  outbox: string;
}

export function sharedRoot(workspaceDir: string): string {
  return path.join(workspaceDir, '.shared');
}

export function sharedPaths(workspaceDir: string, agent: string): SharedPaths {
  const root = sharedRoot(workspaceDir);
  return {
    root,
    inbox: path.join(root, 'inbox'),
    agentInbox: path.join(root, 'inbox', agent),
    outbox: path.join(root, 'outbox', agent),
  };
}

const SHARED_README = `Agent Workspace shared files area (machine-local, never committed).

inbox/            inputs for all agents: specs, designs, data, screenshots
inbox/<agent>/    inputs for one agent
outbox/<agent>/   non-code deliverables produced by one agent

Add files:   aw files add <file...> [--agent <name>] [--tell]
List files:  aw files
`;

export async function ensureShared(workspaceDir: string, agent?: string): Promise<SharedPaths | null> {
  const root = sharedRoot(workspaceDir);
  await ensureDir(path.join(root, 'inbox'));
  await ensureDir(path.join(root, 'outbox'));
  await writeFileExclusive(path.join(root, 'README.txt'), SHARED_README);
  if (!agent) return null;
  const paths = sharedPaths(workspaceDir, agent);
  await ensureDir(paths.agentInbox);
  await ensureDir(paths.outbox);
  return paths;
}

/** Pick a free name in `dir`: "spec.pdf", then "spec (2).pdf", ... */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

async function sha1(file: string): Promise<string> {
  return createHash('sha1').update(await fsp.readFile(file)).digest('hex');
}

/**
 * Copy files or directories into an inbox. Never overwrites: identical files
 * are reused, different files with the same name get a numbered name.
 */
export async function addToInbox(sources: string[], inbox: string): Promise<string[]> {
  await ensureDir(inbox);
  const results: string[] = [];
  for (const source of sources) {
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat) throw new AwError(`File not found: ${source}`, { exitCode: ExitCode.USAGE });
    const name = path.basename(path.resolve(source));
    const existing = path.join(inbox, name);
    if (stat.isFile() && (await pathExists(existing)) && (await sha1(existing)) === (await sha1(source))) {
      results.push(existing);
      continue;
    }
    const dest = await freeName(inbox, name);
    await fsp.cp(source, dest, { recursive: true, errorOnExist: true, force: false });
    results.push(dest);
  }
  return results;
}

export interface FileEntry {
  path: string;
  size: number;
  modified: Date;
}

async function listFiles(dir: string, limit = 500): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= limit) return;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        out.push({ path: full, size: stat.size, modified: stat.mtime });
      }
    }
  };
  await walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface SharedListing {
  root: string;
  inbox: FileEntry[];
  outbox: Record<string, FileEntry[]>;
}

export async function listShared(workspaceDir: string): Promise<SharedListing> {
  const root = sharedRoot(workspaceDir);
  const inbox = await listFiles(path.join(root, 'inbox'));
  const outbox: Record<string, FileEntry[]> = {};
  for (const agent of (await fsp.readdir(path.join(root, 'outbox')).catch(() => [] as string[])).sort()) {
    outbox[agent] = await listFiles(path.join(root, 'outbox', agent));
  }
  return { root, inbox, outbox };
}

// ------------------------------------------------------------ local files

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.venv', 'venv', 'target', '.next', '__pycache__']);

/** Expand `workspace.copyFiles` patterns (literal paths or globs) against the main worktree. */
export async function expandCopyPatterns(root: string, patterns: string[]): Promise<string[]> {
  const found = new Set<string>();
  const globs: RegExp[] = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    if (clean.startsWith('/') || clean.split('/').includes('..')) {
      throw new AwError(`workspace.copyFiles entry "${pattern}" must be a path inside the repository.`, { exitCode: ExitCode.USAGE });
    }
    if (/[*?[{]/.test(clean)) globs.push(globToRegExp(clean));
    else if (await pathExists(path.join(root, clean))) found.add(clean);
  }
  if (globs.length) {
    let budget = 20000;
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])) {
        if (--budget < 0) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) await walk(childRel);
        } else if (entry.isFile() && globs.some((g) => g.test(childRel))) {
          found.add(childRel);
        }
      }
    };
    await walk('');
  }
  return [...found].sort();
}

export interface CopiedFile {
  path: string;
  sha1: string;
}

export interface CopyReport {
  copied: string[];
  skippedExisting: string[];
  skippedNotIgnored: string[];
}

/**
 * Copy local, git-ignored files into a worktree. Files that are not ignored
 * in the worktree are refused: an agent could otherwise commit them (.env!).
 */
export async function copyLocalFiles(
  git: Git,
  sourceRoot: string,
  worktreePath: string,
  patterns: string[],
  recordFile: string,
): Promise<CopyReport> {
  const report: CopyReport = { copied: [], skippedExisting: [], skippedNotIgnored: [] };
  if (!patterns.length) return report;
  const files = await expandCopyPatterns(sourceRoot, patterns);
  const record = await readCopyRecord(recordFile);
  for (const rel of files) {
    const dest = path.join(worktreePath, rel);
    if (await pathExists(dest)) {
      report.skippedExisting.push(rel);
      continue;
    }
    if (!(await git.isIgnored(worktreePath, rel))) {
      report.skippedNotIgnored.push(rel);
      continue;
    }
    await ensureDir(path.dirname(dest));
    await fsp.copyFile(path.join(sourceRoot, rel), dest);
    record[rel] = await sha1(dest);
    report.copied.push(rel);
  }
  if (report.copied.length) await writeFileAtomic(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  return report;
}

async function readCopyRecord(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse((await readTextIfExists(file)) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Copied files that are still byte-identical to what was copied (safe to delete). */
export async function unchangedCopies(worktreePath: string, recordFile: string): Promise<string[]> {
  const record = await readCopyRecord(recordFile);
  const result: string[] = [];
  for (const [rel, hash] of Object.entries(record)) {
    const file = path.join(worktreePath, rel);
    if ((await pathExists(file)) && (await sha1(file)) === hash) result.push(rel);
  }
  return result;
}
