import { randomBytes } from 'node:crypto';
import { constants, promises as fsp, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Portable filesystem helpers built on Node APIs only. */

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isEmptyDirectory(p: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(p);
    return entries.length === 0;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Write a file atomically: write to a temporary sibling, then rename.
 * Readers never observe a partially written file, which protects runtime
 * state against interrupted commands.
 */
export async function writeFileAtomic(p: string, data: string, mode?: number): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
  try {
    await fsp.rename(tmp, p);
  } catch (error) {
    await fsp.rm(tmp, { force: true });
    throw error;
  }
}

/** Create a file only if it does not exist. Returns false when it already existed. */
export async function writeFileExclusive(p: string, data: string): Promise<boolean> {
  await ensureDir(path.dirname(p));
  try {
    await fsp.writeFile(p, data, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Expand a leading `~` to the current user's home directory (platform aware). */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Replace the home directory prefix with `~` for display. */
export function displayPath(p: string): string {
  const home = os.homedir();
  if (home && (p === home || p.startsWith(home + path.sep))) return `~${p.slice(home.length)}`;
  return p;
}

/** Resolve symlinks when possible (e.g. macOS /var -> /private/var). */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // Path may not exist yet: canonicalize the closest existing parent.
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(canonicalPath(parent), path.basename(p));
  }
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/** True when `child` is inside (or equal to) `parent`. */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(canonicalPath(parent), canonicalPath(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
