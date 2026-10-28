import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultDeps } from '../src/core/deps.js';
import { LiveWorkspaceController } from '../src/core/workspace/controller.js';
import { initWorkspace } from '../src/core/workspace/init.js';
import { captureUi, commitFile, createRepo, fakeAgentCli, git, hasTmux, killTmuxServer, tempDir, waitFor } from './helpers.js';

/** The TUI's data and action layer against real repositories, real (private) tmux and fake agent CLIs. */

const socket = `aw-ctl-${process.pid}`;

function setup() {
  const { root, parent } = createRepo('shop');
  const dataDir = tempDir('aw-data-');
  const deps = createDefaultDeps({ cwd: root, env: { ...process.env, AW_TMUX_SOCKET: socket, AW_DATA_DIR: dataDir }, ui: captureUi(), dataDir });
  return { root, parent, deps, controller: new LiveWorkspaceController(deps) };
}

async function initWithFake(root: string, deps: ReturnType<typeof createDefaultDeps>) {
  await initWorkspace({ ...deps, cwd: root }, { provider: 'codex' });
  const bin = tempDir('aw-bin-');
  const codex = fakeAgentCli(bin, 'codex', '--model --cd --add-dir resume');
  const file = path.join(root, '.agents', 'workspace.yaml');
  writeFileSync(
    file,
    readFileSync(file, 'utf8')
      .replace('# Optional per-provider settings', `providers:\n  codex:\n    command: ${codex.path}\n\n# Optional per-provider settings`)
      .replace('agents: {}', 'agents:\n  api:\n    provider: codex\n    branch: feat/api\n    description: Users API'),
  );
  git(root, 'add', '.agents');
  git(root, 'commit', '-q', '-m', 'aw config');
  return codex;
}

describe.runIf(hasTmux())('LiveWorkspaceController', () => {
  beforeEach(() => killTmuxServer(socket));
  afterAll(() => killTmuxServer(socket));

  it('reports registered projects with meaningful states', async () => {
    const { root, deps, controller } = setup();
    expect(await controller.initialProject()).toBeNull(); // not initialized, nothing registered
    const plain = await controller.registerProject(root);
    expect(plain.ok).toBe(true);
    let snap = await controller.snapshot(plain.project!.id);
    expect(snap.state).toBe('not-initialized');
    expect(snap.hint).toMatch(/aw init/);

    expect((await controller.initProject(plain.project!.id)).ok).toBe(true);
    snap = await controller.snapshot(plain.project!.id);
    expect(snap.state).toBe('ready');
    expect(snap.config?.baseBranch).toBe('main');
    expect(snap.agents).toEqual([]);

    const gone = createRepo('gone');
    const reg = await controller.registerProject(gone.root);
    rmSync(gone.root, { recursive: true, force: true });
    const summaries = await controller.listProjects();
    expect(summaries.find((s) => s.project.id === reg.project!.id)?.state).toBe('missing');
    expect((await controller.snapshot(reg.project!.id)).state).toBe('missing');
    expect((await controller.registerProject('/no/such/dir')).ok).toBe(false);
    expect((await controller.forgetProject(reg.project!.id)).ok).toBe(true);
    expect(controller.activity().some((a) => a.kind === 'error' && /Register failed/.test(a.text))).toBe(true);
    expect(deps.projects.file.startsWith(deps.dataDir)).toBe(true);
  });

  it('drives the agent lifecycle and exposes logs, diffs, branches and sessions', async () => {
    const { root, parent, deps, controller } = setup();
    const codex = await initWithFake(root, deps);
    const project = await controller.initialProject();
    expect(project?.name).toBe('shop');
    const id = project!.id;

    let snap = await controller.snapshot(id);
    expect(snap.agents.map((a) => [a.name, a.session, a.description])).toEqual([['api', 'not-spawned', 'Users API']]);
    await expect(controller.attachTarget(id, 'api')).rejects.toThrow(/no tmux session/);

    expect((await controller.startAgent(id, 'api')).ok).toBe(true);
    await waitFor(() => readFileSync(codex.log, 'utf8').includes('---'));
    snap = await controller.snapshot(id);
    const api = snap.agents[0]!;
    expect(api).toMatchObject({ session: 'running', branch: 'feat/api', profile: 'default' });
    expect(api.lastActivity).not.toBeNull();
    expect(await controller.attachTarget(id, 'api')).toBe(api.sessionName);
    await waitFor(async () => (await controller.logs(id, 'api')).includes('Starting Codex'));

    const wt = path.join(parent, '.agent-workspace', 'shop', 'api');
    commitFile(wt, 'src/users.ts', 'export const users = [];\n', 'Add users');
    writeFileSync(path.join(wt, 'notes.md'), 'wip');
    const diff = await controller.diff(id, 'api');
    expect(diff).toContain('## Commits not in main');
    expect(diff).toContain('Add users');
    expect(diff).toContain('src/users.ts');
    expect(diff).toContain('?? notes.md');

    snap = await controller.snapshot(id);
    expect(snap.branches.find((b) => b.name === 'feat/api')).toMatchObject({ agent: 'api', ahead: 1, behind: 0, worktree: wt });
    expect(snap.branches.find((b) => b.name === 'main')).toMatchObject({ current: true, agent: null });

    expect((await controller.restartAgent(id, 'api', { resume: true })).ok).toBe(true);
    await waitFor(() => readFileSync(codex.log, 'utf8').includes('arg=resume'));
    expect((await controller.stopAgent(id, 'api')).ok).toBe(true);
    snap = await controller.snapshot(id);
    expect(snap.agents[0]?.session).toBe('stopped');
    expect(snap.agents[0]?.worktreeExists).toBe(true); // stopping never removes work
    expect(await controller.logs(id, 'api')).toMatch(/no tmux session/);
    expect(controller.activity().map((a) => a.text)).toEqual(expect.arrayContaining(['Started api', 'Stopped api (worktree and branch kept)']));

    const summary = (await controller.listProjects()).find((s) => s.project.id === id)!;
    expect(summary).toMatchObject({ state: 'ready', agents: 1, running: 0 });
    expect((await controller.providers()).map((p) => p.id)).toEqual(['codex', 'claude']);
    expect(controller.settings().dataDir).toBe(deps.dataDir);
  });

  it('turns failures into results instead of crashing the frontend', async () => {
    const { root, deps, controller } = setup();
    await initWithFake(root, deps);
    const id = (await controller.initialProject())!.id;
    const result = await controller.stopAgent(id, 'Bad Name');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Invalid agent name/);
    expect((await controller.startAgent('prj_unknown', 'api')).ok).toBe(false);
  });
});
