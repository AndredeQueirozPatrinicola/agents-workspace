import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addAgentToConfig, parseConfig, resolveAgent, validateAgentName } from '../src/core/config/loader.js';
import { findDependencyCycle } from '../src/core/config/schema.js';
import { AwError } from '../src/core/errors.js';
import { readTemplate } from '../src/infrastructure/filesystem/package-root.js';
import { tempDir } from './helpers.js';

const providers = ['codex', 'claude'];

function parse(yaml: string) {
  return parseConfig(yaml, 'workspace.yaml', providers);
}

function parseError(yaml: string): AwError {
  try {
    parse(yaml);
  } catch (error) {
    if (error instanceof AwError) return error;
    throw error;
  }
  throw new Error('expected parseConfig to throw');
}

const minimal = 'version: 1\nproject:\n  name: my-saas\n';

describe('configuration schema', () => {
  it('applies defaults to a minimal configuration', () => {
    const { config, warnings } = parse(minimal);
    expect(config.project.baseBranch).toBe('main');
    expect(config.project.remote).toBe('origin');
    expect(config.workspace).toEqual({ directory: 'auto', terminal: 'tmux', branchPrefix: 'agent/' });
    expect(config.defaults).toEqual({ provider: 'codex', createDraftPR: true, autoCommit: false, autoMerge: false });
    expect(config.agents).toEqual({});
    expect(warnings).toEqual([]);
  });

  it('accepts the documented example', () => {
    const { config } = parse(`
version: 1
project: { name: my-saas, baseBranch: main }
workspace: { directory: auto, terminal: tmux }
defaults: { provider: codex, createDraftPR: true, autoCommit: false, autoMerge: false }
agents:
  backend: { provider: codex, branch: feat/backend, task: tasks/backend.md }
  database: { provider: claude, branch: feat/database, task: tasks/database.md }
  auth: { provider: codex, branch: feat/auth, task: tasks/auth.md, dependsOn: [database] }
  admin: { provider: claude, branch: feat/admin, task: tasks/admin.md, scope: ["apps/admin/**"] }
`);
    expect(Object.keys(config.agents)).toEqual(['backend', 'database', 'auth', 'admin']);
    expect(config.agents.auth?.dependsOn).toEqual(['database']);
  });

  it('accepts the init template', () => {
    const yaml = readTemplate('workspace.yaml')
      .replaceAll('{{projectName}}', 'demo')
      .replaceAll('{{baseBranch}}', 'main')
      .replaceAll('{{remote}}', 'origin')
      .replaceAll('{{provider}}', 'claude');
    expect(parse(yaml).config.defaults.provider).toBe('claude');
  });

  it('reports YAML syntax errors', () => {
    const error = parseError('version: 1\nproject: [unclosed\n');
    expect(error.message).toMatch(/Invalid YAML/);
    expect(error.exitCode).toBe(2);
  });

  it('reports field paths for invalid values and unknown keys', () => {
    const error = parseError(`${minimal}defaults:\n  createDraftPR: "yes"\nagents:\n  api:\n    provder: codex\n`);
    const details = error.details.join('\n');
    expect(details).toMatch(/defaults\.createDraftPR/);
    expect(details).toMatch(/agents\.api.*unknown key\(s\): provder/);
  });

  it('rejects unsupported versions', () => {
    expect(parseError('version: 2\nproject:\n  name: x\n').details.join()).toMatch(/version/);
  });

  it('rejects invalid and reserved agent names', () => {
    expect(parseError(`${minimal}agents:\n  Bad Name: {}\n`).details.join()).toMatch(/invalid agent name/);
    expect(parseError(`${minimal}agents:\n  status: {}\n`).details.join()).toMatch(/reserved/);
  });

  it('rejects unknown providers', () => {
    const error = parseError(`${minimal}agents:\n  api:\n    provider: gemini\n`);
    expect(error.details.join()).toMatch(/agents\.api\.provider: unknown provider "gemini" \(available: codex, claude\)/);
  });

  it('refuses autoMerge: true', () => {
    expect(parseError(`${minimal}defaults:\n  autoMerge: true\n`).details.join()).toMatch(/never merges/);
  });

  it('warns that autoCommit is not implemented', () => {
    expect(parse(`${minimal}defaults:\n  autoCommit: true\n`).warnings.join()).toMatch(/autoCommit/);
  });

  it('validates dependencies', () => {
    expect(parseError(`${minimal}agents:\n  a:\n    dependsOn: [ghost]\n`).details.join()).toMatch(/unknown agent "ghost"/);
    expect(parseError(`${minimal}agents:\n  a:\n    dependsOn: [a]\n`).details.join()).toMatch(/itself/);
    expect(parseError(`${minimal}agents:\n  a: { dependsOn: [b] }\n  b: { dependsOn: [c] }\n  c: { dependsOn: [a] }\n`).details.join()).toMatch(
      /cycle detected: a -> b -> c -> a/,
    );
  });

  it('warns when agents share a branch', () => {
    const { warnings } = parse(`${minimal}agents:\n  a: { branch: feat/x }\n  b: { branch: feat/x }\n`);
    expect(warnings.join()).toMatch(/a, b share branch "feat\/x"/);
  });

  it('finds dependency cycles', () => {
    expect(findDependencyCycle({ a: { dependsOn: ['b'] }, b: {} })).toBeNull();
    expect(findDependencyCycle({ a: { dependsOn: ['b'] }, b: { dependsOn: ['a'] } })).toEqual(['a', 'b', 'a']);
  });
});

describe('agent resolution', () => {
  it('fills defaults and applies overrides', () => {
    const { config } = parse(`${minimal}providers:\n  claude:\n    model: sonnet\nagents:\n  api:\n    provider: claude\n`);
    const api = resolveAgent(config, 'api');
    expect(api).toMatchObject({ provider: 'claude', branch: 'agent/api', base: 'main', task: 'tasks/api.md', model: 'sonnet', configured: true });
    const adhoc = resolveAgent(config, 'web', { provider: 'codex', branch: 'feat/web' });
    expect(adhoc).toMatchObject({ provider: 'codex', branch: 'feat/web', configured: false, model: undefined });
  });

  it('validates agent names', () => {
    expect(() => validateAgentName('backend-api_2')).not.toThrow();
    expect(() => validateAgentName('-x')).toThrow(AwError);
    expect(() => validateAgentName('a'.repeat(33))).toThrow(AwError);
    expect(() => validateAgentName('all')).toThrow(/reserved/);
  });
});

describe('addAgentToConfig', () => {
  it('adds an agent while preserving comments, and refuses duplicates', async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, '.agents'));
    const file = path.join(dir, '.agents', 'workspace.yaml');
    writeFileSync(file, `# keep me\n${minimal}agents: {}\n# trailing comment\n`);
    await addAgentToConfig(file, 'api', { provider: 'codex', branch: 'agent/api', task: 'tasks/api.md' });
    await addAgentToConfig(file, 'web', { provider: 'claude', task: 'tasks/web.md' });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# keep me');
    const { config } = parse(text);
    expect(Object.keys(config.agents)).toEqual(['api', 'web']);
    await expect(addAgentToConfig(file, 'api', {})).rejects.toThrow(/already exists/);
  });
});

describe('bundled SaaS example', () => {
  it('is a valid configuration with non-overlapping scopes and an acyclic dependency graph', async () => {
    const { findScopeOverlaps } = await import('../src/core/safety/safety.js');
    const file = path.join(__dirname, '..', 'examples', 'saas', '.agents', 'workspace.yaml');
    const { config, warnings } = parseConfig(readFileSync(file, 'utf8'), file, providers);
    expect(warnings).toEqual([]);
    expect(Object.keys(config.agents)).toEqual(['database', 'backend', 'auth', 'rbac', 'admin']);
    const scopes = Object.fromEntries(Object.entries(config.agents).map(([n, a]) => [n, a.scope ?? []]));
    expect(findScopeOverlaps(scopes)).toEqual([]);
  });
});
