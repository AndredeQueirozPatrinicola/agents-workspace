import React from 'react';
import { render } from 'ink';
import type { Deps } from '../core/deps.js';
import { LiveWorkspaceController } from '../core/workspace/controller.js';
import { App, type Intent } from './App.js';
import { type UiState, initialUiState } from './state.js';

/**
 * TUI launcher. The Ink app runs until it asks for something it cannot do
 * itself (attach to a tmux session, open a shell); the launcher unmounts it,
 * hands the real terminal to tmux or the shell, then restores the app with
 * the same view state. Agents are never stopped when the TUI exits.
 */

const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';

/**
 * Hand the terminal over completely before running tmux or a shell.
 *
 * After Ink unmounts, Node can still have a pending read on the TTY. A shell
 * with job control (zsh, bash -i) moves itself into its own foreground
 * process group; any further read by this (now background) process gets
 * SIGTTIN, so the shell reports "suspended (tty input)" and Node crashes with
 * "read EIO". Pausing stdin stops the underlying TTY read.
 */
export function releaseTerminal(stdin: NodeJS.ReadStream = process.stdin): void {
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false);
    } catch {
      /* already restored */
    }
  }
  stdin.removeAllListeners('readable');
  stdin.removeAllListeners('data');
  stdin.pause();
}

/** Never crash on a transient TTY read error (e.g. EIO while another process owns the terminal). */
function guardStdin(stdin: NodeJS.ReadStream = process.stdin): void {
  if (stdin.listenerCount('error') === 0) {
    stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EIO' && error.code !== 'EAGAIN') throw error;
    });
  }
}

export interface TuiOptions {
  refreshMs?: number;
}

export async function runTui(deps: Deps, options: TuiOptions = {}): Promise<number> {
  const controller = new LiveWorkspaceController(deps);
  const first = await controller.initialProject();
  let state: UiState = initialUiState(first?.id ?? null);
  let flash: UiState['flash'] = null;
  const out = process.stdout;
  guardStdin();

  for (;;) {
    let intent: Intent = { type: 'quit' };
    out.write(ALT_SCREEN_ON);
    const instance = render(
      <App
        controller={controller}
        initialState={state}
        initialFlash={flash}
        refreshMs={options.refreshMs ?? 3000}
        onIntent={(i, s) => {
          intent = i;
          state = s;
        }}
      />,
      { exitOnCtrlC: false },
    );
    try {
      await instance.waitUntilExit();
    } finally {
      instance.cleanup();
      out.write(ALT_SCREEN_OFF);
      releaseTerminal();
    }
    flash = null;

    const chosen = intent as Intent;
    if (chosen.type === 'quit') {
      out.write('Agent Workspace closed. Agents keep running in tmux; reopen with: aw\n');
      return 0;
    }
    flash = await handOver(deps, chosen);
  }
}

/** Give the terminal to tmux or a shell, and report how it went. */
async function handOver(deps: Deps, intent: Exclude<Intent, { type: 'quit' }>): Promise<UiState['flash']> {
  const out = process.stdout;
  // While tmux or a shell owns the terminal, a stray TTY access must not
  // suspend this process (SIGTTIN/SIGTTOU); reads then fail with EIO, which is guarded.
  const ignore = () => undefined;
  process.on('SIGTTIN', ignore);
  process.on('SIGTTOU', ignore);
  try {
    if (intent.type === 'attach') {
      out.write(
        process.env.TMUX
          ? `Switching this tmux client to ${intent.session}. Return with your tmux prefix + ( or L.\n`
          : `Attaching to ${intent.agent}. Detach with Ctrl-b d to return to Agent Workspace.\n`,
      );
      const code = await deps.terminal.attach(intent.session);
      return code === 0 ? { kind: 'info', text: `Back from ${intent.agent}.` } : { kind: 'error', text: `tmux attach exited with code ${code}.` };
    }
    if (intent.type === 'command') {
      const c = intent.command;
      out.write(`${c.label}\n`);
      const code = await deps.runner.runInteractive(c.command, c.args, { cwd: c.cwd, env: { ...deps.env, ...c.env } });
      return code === 0 ? { kind: 'info', text: `Done: ${c.label}` } : { kind: 'error', text: `${c.command} exited with code ${code}` };
    }
    const shell = deps.env.SHELL || '/bin/sh';
    out.write(`Shell in ${intent.cwd}. Type "exit" to return to Agent Workspace.\n`);
    await deps.runner.runInteractive(shell, [], { cwd: intent.cwd, env: { ...deps.env, AW_TUI_SHELL: '1' } });
    return { kind: 'info', text: 'Back from the shell.' };
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
  } finally {
    process.off('SIGTTIN', ignore);
    process.off('SIGTTOU', ignore);
  }
}
