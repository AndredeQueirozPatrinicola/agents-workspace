import { Git } from './git/git.js';
import { GitHubClient } from './github/github.js';
import { type CommandRunner, NodeCommandRunner } from '../infrastructure/process/runner.js';
import type { TerminalBackend } from '../infrastructure/terminal/backend.js';
import { TmuxBackend } from '../infrastructure/terminal/tmux.js';
import { type Prompter, TerminalPrompter } from '../infrastructure/terminal/prompt.js';
import { type Ui, ui } from '../infrastructure/terminal/ui.js';
import { type ProviderRegistry, createProviderRegistry } from '../providers/registry.js';

/**
 * Dependency container. Commands receive their collaborators from here, so
 * tests can substitute a mock runner, prompter or terminal backend.
 */
export interface Deps {
  runner: CommandRunner;
  git: Git;
  github: GitHubClient;
  providers: ProviderRegistry;
  terminal: TerminalBackend;
  prompter: Prompter;
  ui: Ui;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** argv prefix that re-invokes this CLI (used for the dashboard status window). */
  selfCommand: string[];
}

export function createDefaultDeps(overrides: Partial<Deps> = {}): Deps {
  const runner = overrides.runner ?? new NodeCommandRunner();
  const env = overrides.env ?? process.env;
  return {
    runner,
    git: overrides.git ?? new Git(runner),
    github: overrides.github ?? new GitHubClient(runner),
    providers: overrides.providers ?? createProviderRegistry(runner),
    terminal: overrides.terminal ?? new TmuxBackend(runner, { socketName: env.AW_TMUX_SOCKET || undefined, env }),
    prompter: overrides.prompter ?? new TerminalPrompter(),
    ui: overrides.ui ?? ui,
    env,
    cwd: overrides.cwd ?? process.cwd(),
    selfCommand: overrides.selfCommand ?? [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])],
  };
}
