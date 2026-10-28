import { randomBytes } from 'node:crypto';
import { promises as fsp, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AwError, ExitCode } from '../../core/errors.js';
import { ensureDir } from './fs.js';

/**
 * Cooperative, process-scoped file locks.
 *
 * Acquisition is atomic and the lock file is never observable half-written:
 * the owner info is written to a private temp file which is then hard-linked
 * to the lock path (`link` fails with EEXIST if the lock is held). On
 * filesystems without hard links we fall back to O_EXCL creation; a young
 * empty/unreadable lock is then treated as "being written", never as stale.
 *
 * Locks whose owner process no longer exists on this host are reclaimed by
 * renaming them away (atomic) and re-verifying what was renamed, so a lock
 * acquired concurrently by another process is never deleted. Release only
 * removes the lock if it still belongs to this process.
 */

export interface LockInfo {
  pid: number;
  hostname: string;
  purpose: string;
  createdAt: string;
  /** Random token identifying one acquisition. */
  token?: string;
}

export interface AcquireOptions {
  purpose: string;
  /** How long to wait for a busy lock before failing (default: fail fast). */
  waitMs?: number;
  /** Human-readable description of the locked resource for error messages. */
  resource?: string;
}

/** An unreadable lock younger than this is assumed to be in the middle of being written. */
const UNREADABLE_GRACE_MS = 5000;

const held = new Map<string, string>(); // file -> token
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [file, token] of held) {
      try {
        const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
        if (info.token === token) rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    }
  });
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readLock(file: string): Promise<LockInfo | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      hostname: String(parsed.hostname ?? ''),
      purpose: String(parsed.purpose ?? 'unknown'),
      createdAt: String(parsed.createdAt ?? ''),
      ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
    };
  } catch {
    return null;
  }
}

/** Stale = owned by a dead process on this host. Unreadable info is never stale by itself. */
export function isLockStale(info: LockInfo | null): boolean {
  if (!info) return false;
  if (info.hostname !== os.hostname()) return false; // cannot judge locks from another host
  return !isProcessAlive(info.pid);
}

/** Decide staleness for a lock file, including unreadable files older than the grace period. */
export async function isLockFileStale(file: string): Promise<{ stale: boolean; info: LockInfo | null }> {
  const info = await readLock(file);
  if (info) return { stale: isLockStale(info), info };
  try {
    const stat = await fsp.stat(file);
    return { stale: Date.now() - stat.mtimeMs > UNREADABLE_GRACE_MS, info: null };
  } catch {
    return { stale: false, info: null }; // vanished: not ours to judge
  }
}

function sameLock(a: LockInfo | null, b: LockInfo | null): boolean {
  if (!a || !b) return a === b;
  return a.pid === b.pid && a.hostname === b.hostname && a.createdAt === b.createdAt && a.token === b.token;
}

/**
 * Remove a stale lock without risking someone else's fresh lock:
 * rename it to a unique name (atomic), check that what we moved is the stale
 * lock we inspected, and put it back if it is not.
 */
async function reclaimStale(file: string, expected: LockInfo | null): Promise<void> {
  const graveyard = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fsp.rename(file, graveyard);
  } catch {
    return; // someone else reclaimed or released it first
  }
  const moved = await readLock(graveyard);
  if (expected === null ? moved === null || isLockStale(moved) : sameLock(moved, expected)) {
    await fsp.rm(graveyard, { force: true });
    return;
  }
  // We moved a lock that was acquired in the meantime: restore it if the slot is still free.
  try {
    await fsp.link(graveyard, file);
  } catch {
    /* slot taken again; the other process will see its lock missing only if it checks */
  }
  await fsp.rm(graveyard, { force: true });
}

/** Remove a lock file if (and only if) it is stale. Returns the removed lock's info, or undefined if kept. */
export async function removeIfStale(file: string): Promise<{ removed: boolean; info: LockInfo | null }> {
  const { stale, info } = await isLockFileStale(file);
  if (!stale) return { removed: false, info };
  await reclaimStale(file, info);
  return { removed: true, info };
}

async function tryCreate(file: string, info: LockInfo): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(info), { flag: 'wx' });
  try {
    await fsp.link(tmp, file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
      // No hard links on this filesystem: fall back to O_EXCL.
      try {
        await fsp.writeFile(file, JSON.stringify(info), { flag: 'wx' });
        return true;
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw inner;
      }
    }
    throw error;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

export class FileLock {
  private released = false;

  private constructor(
    readonly file: string,
    private readonly token: string,
  ) {}

  static async acquire(file: string, options: AcquireOptions): Promise<FileLock> {
    await ensureDir(path.dirname(file));
    const deadline = Date.now() + (options.waitMs ?? 0);
    for (;;) {
      const info: LockInfo = {
        pid: process.pid,
        hostname: os.hostname(),
        purpose: options.purpose,
        createdAt: new Date().toISOString(),
        token: randomBytes(8).toString('hex'),
      };
      if (await tryCreate(file, info)) {
        held.set(file, info.token as string);
        installExitHook();
        return new FileLock(file, info.token as string);
      }
      const { stale, info: existing } = await isLockFileStale(file);
      if (stale) {
        await reclaimStale(file, existing);
        continue;
      }
      if (Date.now() >= deadline) {
        const who = existing ? `pid ${existing.pid}, "${existing.purpose}", since ${existing.createdAt}` : 'owner unknown';
        throw new AwError(`${options.resource ?? 'Resource'} is busy: another aw process is managing it (${who}).`, {
          exitCode: ExitCode.UNSAFE,
          hint: 'Wait for the other command to finish. If no other aw process is running, run "aw repair" to clear stale locks.',
        });
      }
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }

  /** Release the lock, but only if it is still ours. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    held.delete(this.file);
    const current = await readLock(this.file);
    if (current?.token === this.token) await fsp.rm(this.file, { force: true });
  }
}

export async function withLock<T>(file: string, options: AcquireOptions, fn: () => Promise<T>): Promise<T> {
  const lock = await FileLock.acquire(file, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Try to run `fn` under the lock; returns null (without running) if the lock is busy. */
export async function tryWithLock<T>(file: string, options: AcquireOptions, fn: () => Promise<T>): Promise<T | null> {
  let lock: FileLock;
  try {
    lock = await FileLock.acquire(file, options);
  } catch (error) {
    if (error instanceof AwError && error.exitCode === ExitCode.UNSAFE) return null;
    throw error;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
