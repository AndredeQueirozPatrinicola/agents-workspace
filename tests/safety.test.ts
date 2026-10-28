import { describe, expect, it } from 'vitest';
import {
  findScopeOverlaps,
  globPrefix,
  globsMayOverlap,
  isSensitivePath,
  matchesAny,
  scanForSecrets,
} from '../src/core/safety/safety.js';

describe('scope overlap detection', () => {
  it('computes static glob prefixes', () => {
    expect(globPrefix('src/api/**')).toBe('src/api/');
    expect(globPrefix('./src/*.ts')).toBe('src/');
    expect(globPrefix('README.md')).toBe('README.md');
  });

  it('detects possibly overlapping globs conservatively', () => {
    expect(globsMayOverlap('src/api/**', 'src/api/users.ts')).toBe(true);
    expect(globsMayOverlap('src/**', 'src/api/**')).toBe(true);
    expect(globsMayOverlap('src/api/**', 'src/web/**')).toBe(false);
    expect(globsMayOverlap('src/api/**', 'src/apidocs/**')).toBe(false);
    expect(globsMayOverlap('package.json', 'package.json')).toBe(true);
    expect(globsMayOverlap('package.json', 'package-lock.json')).toBe(false);
  });

  it('reports overlapping agent scopes', () => {
    const overlaps = findScopeOverlaps({
      backend: ['src/api/**', 'src/db/schema.ts'],
      database: ['src/db/**'],
      admin: ['apps/admin/**'],
    });
    expect(overlaps).toEqual([{ a: 'backend', b: 'database', patterns: [['src/db/schema.ts', 'src/db/**']] }]);
  });

  it('matches files against globs', () => {
    expect(matchesAny('src/api/users/index.ts', ['src/api/**'])).toBe(true);
    expect(matchesAny('src/api.ts', ['src/api/**'])).toBe(false);
    expect(matchesAny('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(matchesAny('src/deep/a.ts', ['src/*.ts'])).toBe(false);
    expect(matchesAny('src/deep/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesAny('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesAny('docs/x.md', ['{docs,examples}/**'])).toBe(true);
    expect(matchesAny('src/api/x', ['src/api'])).toBe(true);
  });
});

describe('publication safety', () => {
  it('flags sensitive and local-only files', () => {
    for (const f of ['.env', 'apps/web/.env.local', 'certs/server.pem', '.ssh/id_rsa', '.npmrc', 'config/credentials.json', '.agent-workspace/x']) {
      expect(isSensitivePath(f), f).toBe(true);
    }
    for (const f of ['.env.example', '.env.sample', 'src/env.ts', 'README.md', 'keys.ts']) {
      expect(isSensitivePath(f), f).toBe(false);
    }
  });

  it('detects common secret formats in added lines', () => {
    const findings = scanForSecrets([
      { file: 'a.ts', line: 'const key = "AKIAABCDEFGHIJKLMNOP";' },
      { file: 'b.txt', line: '-----BEGIN OPENSSH PRIVATE KEY-----' },
      { file: 'c.ts', line: `token = "ghp_${'a'.repeat(36)}"` },
      { file: 'd.ts', line: 'const x = 1;' },
    ]);
    expect(findings).toEqual([
      { file: 'a.ts', kind: 'AWS access key id' },
      { file: 'b.txt', kind: 'private key' },
      { file: 'c.ts', kind: 'GitHub token' },
    ]);
  });
});
