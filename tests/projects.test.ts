import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from '../src/core/projects/paths.js';
import { JsonProjectRegistry, projectIdFor } from '../src/core/projects/registry.js';
import { Git } from '../src/core/git/git.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import { runCli } from '../src/cli/run.js';
import { ScriptedPrompter, captureUi, createRepo, git, tempDir } from './helpers.js';

const g = new Git(new NodeCommandRunner());

describe('data directory', () => {
  it('follows AW_DATA_DIR, XDG and platform conventions', () => {
    expect(resolveDataDir({ AW_DATA_DIR: '/custom/aw' }, 'linux', '/home/u')).toBe('/custom/aw');
    expect(resolveDataDir({ XDG_DATA_HOME: '/xdg' }, 'darwin', '/Users/u')).toBe('/xdg/agent-workspace');
    expect(resolveDataDir({ XDG_DATA_HOME: 'relative' }, 'linux', '/home/u')).toBe('/home/u/.local/share/agent-workspace');
    expect(resolveDataDir({}, 'linux', '/home/u')).toBe('/home/u/.local/share/agent-workspace');
    expect(resolveDataDir({}, 'darwin', '/Users/u')).toBe('/Users/u/Library/Application Support/agent-workspace');
  });
});

describe('JsonProjectRegistry', () => {
  const registry = () => new JsonProjectRegistry(path.join(tempDir('aw-data-'), 'projects.json'), g);

  it('registers repositories in place and resolves every path of a repo to one project', async () => {
    const reg = registry();
    const { root, parent } = createRepo('shop');
    mkdirSync(path.join(root, '.agents'));
    writeFileSync(path.join(root, '.agents', 'workspace.yaml'), 'version: 1\nproject:\n  name: shop-api\n');
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    const linked = path.join(parent, 'linked');
    git(root, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const first = await reg.register(path.join(root, 'src', 'deep'));
    expect(first.created).toBe(true);
    expect(first.project).toMatchObject({ name: 'shop-api', path: root, id: projectIdFor(path.join(root, '.git')) });
    expect((await reg.register(linked)).created).toBe(false); // same common dir
    expect(await reg.list()).toHaveLength(1);
    expect((await reg.findContaining(linked))?.id).toBe(first.project.id);
    expect((await reg.get('shop-api'))?.id).toBe(first.project.id);
    expect((await reg.get(root))?.id).toBe(first.project.id);
    expect(await reg.findContaining(tempDir())).toBeUndefined();
  });

  it('uses the directory name for repositories without configuration and forgets without touching them', async () => {
    const reg = registry();
    const { root } = createRepo('plain-repo');
    const { project } = await reg.register(root);
    expect(project.name).toBe('plain-repo');
    expect(await reg.remove(project.id)).toBe(true);
    expect(await reg.remove(project.id)).toBe(false);
    expect(await reg.list()).toEqual([]);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# test\n');
  });

  it('rejects paths that are missing or not Git repositories', async () => {
    const reg = registry();
    await expect(reg.register('/definitely/not/here')).rejects.toThrow(/Path not found/);
    await expect(reg.register(tempDir())).rejects.toThrow(/Not inside a Git repository/);
  });

  it('survives concurrent registrations and recovers from a corrupt file', async () => {
    const reg = registry();
    const repos = Array.from({ length: 8 }, (_, i) => createRepo(`repo-${i}`).root);
    await Promise.all(repos.map((r) => reg.register(r)));
    expect((await reg.list()).map((p) => p.name).sort()).toEqual(repos.map((r) => path.basename(r)).sort());

    writeFileSync(reg.file, '{ not json');
    expect(await reg.list()).toEqual([]);
    await reg.register(repos[0] as string);
    expect(await reg.list()).toHaveLength(1);
  });
});

describe('aw projects', () => {
  async function aw(args: string[], cwd: string, dataDir: string) {
    const ui = captureUi();
    const code = await runCli(['node', 'aw', ...args], {
      cwd,
      ui,
      env: { ...process.env, AW_DATA_DIR: dataDir },
      prompter: new ScriptedPrompter(false),
    });
    return { code, ui };
  }

  it('adds, lists and removes projects; initialized repositories register themselves', async () => {
    const dataDir = tempDir('aw-data-');
    const { root: a } = createRepo('alpha');
    const { root: b } = createRepo('beta');

    let r = await aw(['projects'], a, dataDir);
    expect(r.ui.text()).toMatch(/No projects registered yet/);

    r = await aw(['projects', 'add', b], a, dataDir);
    expect(r.code).toBe(0);
    expect(r.ui.text()).toMatch(/Registered: beta/);

    // Running a command in an initialized repository registers it.
    expect((await aw(['init'], a, dataDir)).code).toBe(0);
    expect((await aw(['status'], a, dataDir)).code).toBe(0);
    r = await aw(['projects', '--json'], a, dataDir);
    expect((JSON.parse(r.ui.out.join('\n')) as Array<{ name: string }>).map((p) => p.name).sort()).toEqual(['alpha', 'beta']);

    r = await aw(['projects', 'remove', 'beta'], a, dataDir);
    expect(r.ui.text()).toMatch(/Forgot beta/);
    expect((await aw(['projects', 'remove', 'beta'], a, dataDir)).code).toBe(2);
  });
});

describe('aw entry point', () => {
  it('prints help without a terminal, refuses "aw ui" in scripts and reports unknown commands', async () => {
    const ui = captureUi();
    const deps = { cwd: tempDir(), ui, prompter: new ScriptedPrompter(false) };
    expect(await runCli(['node', 'aw'], deps)).toBe(0);
    expect(await runCli(['node', 'aw', 'ui'], deps)).toBe(2);
    expect(ui.text()).toMatch(/needs an interactive terminal/);
    expect(await runCli(['node', 'aw', 'bogus'], deps)).toBe(2);
    expect(ui.text()).toMatch(/Unknown command "bogus"/);
  });
});
