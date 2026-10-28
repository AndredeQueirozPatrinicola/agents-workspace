import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the installed package root (the directory containing package.json),
 * so bundled templates can be found both from `src/` (tests) and `dist/`.
 */
let cached: string | null = null;

export function packageRoot(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (pkg.name === 'agent-workspace') {
          cached = dir;
          return dir;
        }
      } catch {
        /* keep searching */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not locate the agent-workspace package root.');
    dir = parent;
  }
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

export function templatePath(...segments: string[]): string {
  return path.join(packageRoot(), 'templates', ...segments);
}

export function readTemplate(...segments: string[]): string {
  return readFileSync(templatePath(...segments), 'utf8');
}
