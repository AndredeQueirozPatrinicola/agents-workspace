import { delimiter } from 'node:path';
import path from 'node:path';
import { promises as fsp, constants } from 'node:fs';

/**
 * POSIX shell helpers used only to generate launcher scripts.
 * Runtime commands never go through a shell; see runner.ts.
 */

/** Quote a string for safe inclusion in a POSIX sh script. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Locate an executable on PATH (or verify an explicit path). */
export async function findExecutable(command: string, envPath = process.env.PATH ?? ''): Promise<string | null> {
  const candidates = command.includes('/') || command.includes('\\')
    ? [command]
    : envPath
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const candidate of candidates) {
    for (const ext of exts) {
      const file = candidate + ext;
      try {
        const stat = await fsp.stat(file);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') await fsp.access(file, constants.X_OK);
        return file;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/** Extract the first semver-like version number from a string. */
export function parseVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return `${match[1]}.${match[2]}.${match[3] ?? '0'}`;
}

/** Compare two dotted versions. Returns negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
