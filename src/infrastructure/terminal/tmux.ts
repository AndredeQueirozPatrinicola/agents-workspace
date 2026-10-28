import { AwError, ExitCode } from '../../core/errors.js';
import { type CommandRunner, ensureSuccess, type RunResult } from '../process/runner.js';
import { compareVersions, findExecutable, parseVersion } from '../process/shell.js';
import type { CreateSessionOptions, DashboardOptions, PaneState, TerminalBackend } from './backend.js';

/**
 * tmux terminal backend.
 *
 * - Each agent gets its own detached session, so it survives terminal
 *   disconnects and is independent of other agents.
 * - Targets always use the `=name` exact-match form so we never act on a
 *   user session whose name merely starts with ours.
 * - `AW_TMUX_SOCKET` selects a separate tmux server (`tmux -L <name>`), used
 *   by tests and by users who want full isolation from their own tmux.
 * - The dashboard is a separate session whose panes run nested
 *   `tmux attach` clients. Killing or detaching the dashboard only ends those
 *   viewer clients; agent sessions keep running.
 */

export const MIN_TMUX_VERSION = '3.0';

export interface TmuxOptions {
  socketName?: string | undefined;
  /** Environment used to detect whether we are already inside tmux. */
  env?: NodeJS.ProcessEnv;
}

export class TmuxBackend implements TerminalBackend {
  readonly id = 'tmux';
  private readonly socketArgs: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly runner: CommandRunner,
    options: TmuxOptions = {},
  ) {
    this.socketArgs = options.socketName ? ['-L', options.socketName] : [];
    this.env = options.env ?? process.env;
  }

  /** Arguments that select the tmux server (exposed for command construction tests). */
  baseArgs(): string[] {
    return [...this.socketArgs];
  }

  private run(args: string[]): Promise<RunResult> {
    return this.runner.run('tmux', [...this.socketArgs, ...args]);
  }

  private async exec(args: string[], context: string): Promise<string> {
    return ensureSuccess(await this.run(args), context).stdout;
  }

  async isAvailable(): Promise<boolean> {
    return (await findExecutable('tmux')) !== null;
  }

  async version(): Promise<string | null> {
    try {
      const result = await this.runner.run('tmux', ['-V']);
      return result.exitCode === 0 ? parseVersion(result.stdout) : null;
    } catch {
      return null;
    }
  }

  async assertUsable(): Promise<void> {
    if (!(await this.isAvailable())) {
      throw new AwError('tmux is not installed.', {
        exitCode: ExitCode.PREREQUISITE,
        hint: 'Install tmux (Ubuntu/WSL: sudo apt install tmux, macOS: brew install tmux), then run "aw doctor".',
      });
    }
    const v = await this.version();
    if (v && compareVersions(v, MIN_TMUX_VERSION) < 0) {
      throw new AwError(`tmux ${v} is too old; Agent Workspace requires tmux ${MIN_TMUX_VERSION} or newer.`, {
        exitCode: ExitCode.PREREQUISITE,
      });
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      return (await this.run(['has-session', '-t', `=${name}`])).exitCode === 0;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<string[]> {
    try {
      const result = await this.run(['list-sessions', '-F', '#{session_name}']);
      if (result.exitCode !== 0) return []; // "no server running" is not an error
      return result.stdout.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async createSession(options: CreateSessionOptions): Promise<void> {
    if (options.command.length < 2) {
      // tmux runs a single-argument command through the shell; we always pass >= 2 args to exec directly.
      throw new Error('createSession requires the command as at least two argv elements.');
    }
    await this.exec(
      ['new-session', '-d', '-s', options.name, '-n', options.windowName ?? 'agent', '-c', options.cwd, ...options.command],
      `Creating tmux session ${options.name}`,
    );
    // set-option takes a target *pane*, so the exact-match form needs a trailing colon.
    const target = `=${options.name}:`;
    for (const [key, value] of Object.entries(options.tags ?? {})) {
      await this.run(['set-option', '-t', target, `@${key}`, value]);
    }
    // Size windows to the most recently active client so attaching from a
    // large terminal after viewing in the dashboard gives a full-size view.
    await this.run(['set-option', '-t', target, 'window-size', 'latest']);
  }

  async killSession(name: string): Promise<void> {
    if (!(await this.hasSession(name))) return;
    await this.exec(['kill-session', '-t', `=${name}`], `Stopping tmux session ${name}`);
  }

  /** The session's first pane (where the agent runs), even if the user split the window. */
  private async agentPane(name: string): Promise<string> {
    const panes = await this.run(['list-panes', '-s', '-t', `=${name}`, '-F', '#{pane_id}']);
    const pane = panes.exitCode === 0 ? panes.stdout.split('\n')[0]?.trim() : '';
    return pane || `=${name}:`;
  }

  async sendKeys(name: string, keys: string[]): Promise<void> {
    await this.exec(['send-keys', '-t', await this.agentPane(name), ...keys], `Sending keys to ${name}`);
  }

  async sendText(name: string, text: string): Promise<void> {
    const pane = await this.agentPane(name);
    // -l: literal text (no key-name interpretation); Enter is sent separately
    // after a short pause so TUIs register the text before submitting.
    await this.exec(['send-keys', '-t', pane, '-l', text], `Sending text to ${name}`);
    await new Promise((r) => setTimeout(r, 150));
    await this.exec(['send-keys', '-t', pane, 'Enter'], `Sending Enter to ${name}`);
  }

  async respawn(name: string, cwd: string, command: string[]): Promise<void> {
    if (command.length < 2) throw new Error('respawn requires the command as at least two argv elements.');
    await this.exec(['respawn-pane', '-k', '-t', await this.agentPane(name), '-c', cwd, ...command], `Relaunching ${name}`);
  }

  async paneState(name: string): Promise<PaneState | null> {
    const result = await this.run(['list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}|#{pane_dead}|#{pane_current_command}']);
    if (result.exitCode !== 0) return null;
    // tmux escapes control characters in formats, so use a printable separator.
    const [pid, dead, ...command] = (result.stdout.split('\n')[0] ?? '').split('|');
    return { pid: pid ? Number.parseInt(pid, 10) : null, dead: dead === '1', currentCommand: command.join('|') };
  }

  async capture(name: string, lines = 30): Promise<string> {
    const result = await this.run(['capture-pane', '-p', '-t', `=${name}:`, '-S', `-${lines}`]);
    return result.exitCode === 0 ? result.stdout : '';
  }

  attachArgs(name: string): string[] {
    const insideTmux = Boolean(this.env.TMUX);
    return insideTmux ? [...this.socketArgs, 'switch-client', '-t', `=${name}`] : [...this.socketArgs, 'attach-session', '-t', `=${name}`];
  }

  async attach(name: string): Promise<number> {
    return this.runner.runInteractive('tmux', this.attachArgs(name));
  }

  /**
   * Prefix key for the dashboard session: C-a, unless the user's global
   * prefix is already C-a, in which case C-b.
   */
  async dashboardPrefix(): Promise<string> {
    const result = await this.run(['show-options', '-gv', 'prefix']);
    const global = result.exitCode === 0 ? result.stdout.trim() : 'C-b';
    return global === 'C-a' ? 'C-b' : 'C-a';
  }

  /** argv for a dashboard pane that mirrors (and controls) an agent session. */
  viewerCommand(session: string): string[] {
    return ['env', '-u', 'TMUX', 'tmux', ...this.socketArgs, 'attach-session', '-t', `=${session}`];
  }

  async createDashboard(options: DashboardOptions): Promise<void> {
    if (await this.hasSession(options.name)) await this.killSession(options.name);
    const perWindow = Math.max(1, options.perWindow);
    const groups: Array<typeof options.panes> = [];
    for (let i = 0; i < options.panes.length; i += perWindow) groups.push(options.panes.slice(i, i + perWindow));

    let created = false;
    const windows: string[] = [];
    const newWindow = async (name: string, command: string[]): Promise<{ window: string; pane: string }> => {
      const fmt = '#{window_id} #{pane_id}';
      const out = created
        ? await this.exec(['new-window', '-d', '-P', '-F', fmt, '-t', `=${options.name}:`, '-n', name, '-c', options.cwd, ...command], 'Creating dashboard window')
        : await this.exec(['new-session', '-d', '-P', '-F', fmt, '-s', options.name, '-n', name, '-c', options.cwd, ...command], 'Creating dashboard');
      created = true;
      const [window, pane] = out.trim().split(' ');
      if (!window || !pane) throw new AwError('Unexpected tmux output while creating the dashboard.');
      windows.push(window);
      return { window, pane };
    };

    for (const [index, group] of groups.entries()) {
      const first = group[0];
      if (!first) continue;
      const { window, pane } = await newWindow(groups.length > 1 ? `agents-${index + 1}` : 'agents', this.viewerCommand(first.session));
      await this.run(['select-pane', '-t', pane, '-T', first.title]);
      for (const item of group.slice(1)) {
        const newPane = (
          await this.exec(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', window, '-c', options.cwd, ...this.viewerCommand(item.session)], 'Splitting dashboard pane')
        ).trim();
        await this.run(['select-pane', '-t', newPane, '-T', item.title]);
        await this.run(['select-layout', '-t', window, 'tiled']);
      }
      await this.run(['select-layout', '-t', window, 'tiled']);
    }
    if (options.statusCommand && options.statusCommand.length >= 2) {
      await newWindow('status', options.statusCommand);
    }
    if (options.shellCommand && options.shellCommand.length >= 2) {
      await newWindow('shell', options.shellCommand);
    }
    if (!created) throw new AwError('No panes to show in the dashboard.');

    const session = `=${options.name}:`;
    // Dashboard-only session options: they do not affect agent sessions or the
    // user's other sessions. The dashboard uses a different prefix than the
    // agent sessions so that the normal prefix reaches the focused agent.
    const prefix = await this.dashboardPrefix();
    const sessionOptions: Array<[string, string]> = [
      ['prefix', prefix],
      ['mouse', 'on'],
      ['status-left', ' aw dashboard '],
      ['status-left-length', '20'],
      // Always-visible key reminder (dashboard session only).
      ['status-right', ` ${prefix} n/p/0-9: windows | ${prefix} arrows: panes | ${prefix} z: zoom | ${prefix} w: list | ${prefix} d: detach `],
      ['status-right-length', '120'],
    ];
    for (const [key, value] of sessionOptions) await this.run(['set-option', '-t', session, key, value]);
    for (const window of windows) {
      await this.run(['set-window-option', '-t', window, 'pane-border-status', 'top']);
      await this.run(['set-window-option', '-t', window, 'pane-border-format', ' #{pane_index}: #{pane_title} ']);
      await this.run(['set-window-option', '-t', window, 'remain-on-exit', 'on']);
    }
    const firstWindow = windows[0];
    if (firstWindow) await this.run(['select-window', '-t', firstWindow]);
  }
}
