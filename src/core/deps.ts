import { Git } from './git/git.js';
import { GitHubClient } from './github/github.js';
import { type CommandRunner, NodeCommandRunner } from '../infrastructure/process/runner.js';
import type { TerminalBackend } from '../infrastructure/terminal/backend.js';
import { TmuxBackend } from '../infrastructure/terminal/tmux.js';
import { type Prompter, TerminalPrompter } from '../infrastructure/terminal/prompt.js';
import { type Ui, ui } from '../infrastructure/terminal/ui.js';
import { type ProviderRegistry, createProviderRegistry } from '../providers/registry.js';
import { JsonProjectRegistry, type ProjectRegistry } from './projects/registry.js';
import { resolveDataDir } from './projects/paths.js';
import path from 'node:path';

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
  /** Machine-local application data directory. */
  dataDir: string;
  /** Global registry of known projects. */
  projects: ProjectRegistry;
}

export function createDefaultDeps(overrides: Partial<Deps> = {}): Deps {
  const runner = overrides.runner ?? new NodeCommandRunner();
  const env = overrides.env ?? process.env;
  const git = overrides.git ?? new Git(runner);
  const dataDir = overrides.dataDir ?? resolveDataDir(env);
  return {
    runner,
    git,
    github: overrides.github ?? new GitHubClient(runner),
    providers: overrides.providers ?? createProviderRegistry(runner),
    terminal: overrides.terminal ?? new TmuxBackend(runner, { socketName: env.AW_TMUX_SOCKET || undefined, env }),
    prompter: overrides.prompter ?? new TerminalPrompter(),
    ui: overrides.ui ?? ui,
    env,
    cwd: overrides.cwd ?? process.cwd(),
    selfCommand: overrides.selfCommand ?? [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])],
    dataDir,
    projects: overrides.projects ?? new JsonProjectRegistry(path.join(dataDir, 'projects.json'), git),
  };
}
