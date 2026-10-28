import { afterAll, describe, expect, it } from 'vitest';
import { TmuxBackend } from '../src/infrastructure/terminal/tmux.js';
import { NodeCommandRunner } from '../src/infrastructure/process/runner.js';
import { MockRunner, hasTmux, killTmuxServer, waitFor } from './helpers.js';

describe('tmux command construction', () => {
  it('targets sessions by exact name and supports an isolated server socket', async () => {
    const runner = new MockRunner();
    const tmux = new TmuxBackend(runner, { socketName: 'aw-sock', env: {} });
    await tmux.hasSession('aw-p-abc123-api');
    await tmux.createSession({ name: 'aw-p-abc123-api', cwd: '/ws/api', command: ['/bin/sh', '/state/launch.sh'], tags: { aw_agent: 'api' } });
    await tmux.sendKeys('aw-p-abc123-api', ['C-c']);
    expect(runner.calls.map((c) => c.args)).toEqual([
      ['-L', 'aw-sock', 'has-session', '-t', '=aw-p-abc123-api'],
      ['-L', 'aw-sock', 'new-session', '-d', '-s', 'aw-p-abc123-api', '-n', 'agent', '-c', '/ws/api', '/bin/sh', '/state/launch.sh'],
      ['-L', 'aw-sock', 'set-option', '-t', '=aw-p-abc123-api:', '@aw_agent', 'api'],
      ['-L', 'aw-sock', 'set-option', '-t', '=aw-p-abc123-api:', 'window-size', 'latest'],
      ['-L', 'aw-sock', 'list-panes', '-s', '-t', '=aw-p-abc123-api', '-F', '#{pane_id}'],
      ['-L', 'aw-sock', 'send-keys', '-t', '=aw-p-abc123-api:', 'C-c'],
    ]);
  });

  it('types literal text and relaunches the agent pane in place', async () => {
    const runner = new MockRunner((_c, args) => (args.includes('list-panes') ? { stdout: '%7\n%8\n' } : {}));
    const tmux = new TmuxBackend(runner, { env: {} });
    await tmux.sendText('aw-p-1-api', 'fix the tests; $(not a command)');
    await tmux.respawn('aw-p-1-api', '/ws/api', ['/bin/sh', '/state/launch.sh']);
    expect(runner.calls.map((c) => c.args).filter((a) => !a.includes('list-panes'))).toEqual([
      ['send-keys', '-t', '%7', '-l', 'fix the tests; $(not a command)'],
      ['send-keys', '-t', '%7', 'Enter'],
      ['respawn-pane', '-k', '-t', '%7', '-c', '/ws/api', '/bin/sh', '/state/launch.sh'],
    ]);
  });

  it('attaches outside tmux and switches clients inside tmux', () => {
    expect(new TmuxBackend(new MockRunner(), { env: {} }).attachArgs('s')).toEqual(['attach-session', '-t', '=s']);
    expect(new TmuxBackend(new MockRunner(), { env: { TMUX: '/tmp/tmux-1/default,1,0' } }).attachArgs('s')).toEqual([
      'switch-client', '-t', '=s',
    ]);
  });

  it('builds nested viewer commands that do not inherit $TMUX', () => {
    expect(new TmuxBackend(new MockRunner(), { socketName: 'x', env: {} }).viewerCommand('aw-p-1-api')).toEqual([
      'env', '-u', 'TMUX', 'tmux', '-L', 'x', 'attach-session', '-t', '=aw-p-1-api',
    ]);
  });

  it('refuses single-string commands (which tmux would pass to a shell)', async () => {
    const tmux = new TmuxBackend(new MockRunner(), { env: {} });
    await expect(tmux.createSession({ name: 's', cwd: '/', command: ['echo hi; rm -rf /'] })).rejects.toThrow(/at least two argv/);
  });

  it('treats "no server running" as no sessions', async () => {
    const tmux = new TmuxBackend(new MockRunner(() => ({ exitCode: 1, stderr: 'no server running on /tmp/tmux-0/default' })), { env: {} });
    expect(await tmux.listSessions()).toEqual([]);
    expect(await tmux.hasSession('x')).toBe(false);
  });
});

describe.runIf(hasTmux())('tmux integration (isolated server)', () => {
  const socket = `aw-test-${process.pid}`;
  const tmux = new TmuxBackend(new NodeCommandRunner(), { socketName: socket, env: {} });
  afterAll(() => killTmuxServer(socket));

  it('manages session lifecycle without touching other sessions', async () => {
    await tmux.createSession({ name: 'aw-t-1-a', cwd: '/', command: ['/bin/sh', '-c', 'echo started; sleep 30'], tags: { aw_agent: 'a' } });
    await tmux.createSession({ name: 'aw-t-1-ab', cwd: '/', command: ['/bin/sh', '-c', 'sleep 30'] });
    expect(await tmux.hasSession('aw-t-1-a')).toBe(true);
    expect(await tmux.hasSession('aw-t-1')).toBe(false); // exact match only, no prefix matching
    await waitFor(async () => (await tmux.capture('aw-t-1-a')).includes('started'));
    const pane = await tmux.paneState('aw-t-1-a');
    expect(pane).toMatchObject({ dead: false });
    expect(pane?.pid).toBeGreaterThan(0);
    await tmux.killSession('aw-t-1-a');
    expect(await tmux.hasSession('aw-t-1-a')).toBe(false);
    expect(await tmux.hasSession('aw-t-1-ab')).toBe(true);
    await tmux.killSession('aw-t-1-a'); // idempotent
  });

  it('builds a tiled dashboard across windows; killing it leaves agents running', async () => {
    const agents = ['aw-t-2-a', 'aw-t-2-b', 'aw-t-2-c'];
    for (const name of agents) await tmux.createSession({ name, cwd: '/', command: ['/bin/sh', '-c', 'sleep 30'] });
    await tmux.createDashboard({
      name: 'aw-t-2--dashboard',
      cwd: '/',
      panes: agents.map((session) => ({ title: session, session })),
      perWindow: 2,
      statusCommand: ['/bin/sh', '-c', 'sleep 30'],
    });
    const runner = new NodeCommandRunner();
    const windows = await runner.run('tmux', ['-L', socket, 'list-windows', '-t', '=aw-t-2--dashboard', '-F', '#{window_name}:#{window_panes}']);
    expect(windows.stdout.trim().split('\n')).toEqual(['agents-1:2', 'agents-2:1', 'status:1']);
    const prefix = await runner.run('tmux', ['-L', socket, 'show-options', '-t', '=aw-t-2--dashboard:', '-v', 'prefix']);
    expect(prefix.stdout.trim()).toBe('C-a');
    // Agent sessions keep their default prefix.
    const agentPrefix = await runner.run('tmux', ['-L', socket, 'show-options', '-t', '=aw-t-2-a:', 'prefix']);
    expect(agentPrefix.stdout.trim()).toBe('');

    await tmux.killSession('aw-t-2--dashboard');
    for (const name of agents) expect(await tmux.hasSession(name)).toBe(true);
  });
});
