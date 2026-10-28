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

export interface TuiOptions {
  refreshMs?: number;
}

export async function runTui(deps: Deps, options: TuiOptions = {}): Promise<number> {
  const controller = new LiveWorkspaceController(deps);
  const first = await controller.initialProject();
  let state: UiState = initialUiState(first?.id ?? null);
  let flash: UiState['flash'] = null;
  const out = process.stdout;

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
    }
    flash = null;

    const chosen = intent as Intent;
    if (chosen.type === 'quit') {
      out.write('Agent Workspace closed. Agents keep running in tmux; reopen with: aw\n');
      return 0;
    }
    if (chosen.type === 'attach') {
      if (process.env.TMUX) {
        out.write(`Switching this tmux client to ${chosen.session}. Return with your tmux prefix + ( or L.\n`);
      } else {
        out.write(`Attaching to ${chosen.agent}. Detach with Ctrl-b d to return to Agent Workspace.\n`);
      }
      try {
        const code = await deps.terminal.attach(chosen.session);
        flash = code === 0 ? { kind: 'info', text: `Back from ${chosen.agent}.` } : { kind: 'error', text: `tmux attach exited with code ${code}.` };
      } catch (error) {
        flash = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
      continue;
    }
    // shell
    const shell = deps.env.SHELL || '/bin/sh';
    out.write(`Shell in ${chosen.cwd}. Type "exit" to return to Agent Workspace.\n`);
    try {
      await deps.runner.runInteractive(shell, [], { cwd: chosen.cwd, env: { ...deps.env, AW_TUI_SHELL: '1' } });
      flash = { kind: 'info', text: 'Back from the shell.' };
    } catch (error) {
      flash = { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
  }
}
