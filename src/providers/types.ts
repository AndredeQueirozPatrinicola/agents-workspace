/**
 * Agent provider abstraction.
 *
 * A provider knows how to detect and launch one coding-agent CLI. It never
 * executes the agent itself: it only describes the command. Session backends
 * (tmux) are responsible for running it. This keeps provider code pure and
 * trivially testable, and makes adding a provider a single-file change.
 */

import type { Effort } from '../core/accounts/settings.js';

/** A launch argument: a literal string, or the contents of a file (used for long prompts). */
export type LaunchArg = string | { fromFile: string };

export interface LaunchCommand {
  command: string;
  args: LaunchArg[];
  /** Working directory the command must start in. */
  cwd: string;
  /** Extra, non-secret environment variables. */
  env: Record<string, string>;
}

export interface AgentLaunchContext {
  agentName: string;
  projectName: string;
  worktreePath: string;
  branch: string;
  /** Path to a file containing the initial prompt, or null to start without one. */
  promptFile: string | null;
  model: string | undefined;
  /** Arguments from `providers.<id>.args` in workspace.yaml. */
  providerArgs: string[];
  /** Arguments from `agents.<name>.args` and the command line. */
  agentArgs: string[];
  /** Continue the previous conversation instead of starting a new one. */
  resume: boolean;
  /** Extra directories the agent may read and write (shared files area). */
  addDirs: string[];
  /** Override for the executable (from `providers.<id>.command`). */
  command: string | undefined;
  /** Reasoning effort; undefined keeps the CLI's default. */
  effort?: Effort | undefined;
  /** Account configuration directory (CODEX_HOME / CLAUDE_CONFIG_DIR); null/undefined keeps the default login. */
  accountHome?: string | null | undefined;
}

/** A one-shot, non-interactive, read-only run that must answer with JSON matching a schema. */
export interface ExecContext {
  cwd: string;
  prompt: string;
  /** JSON schema of the answer (strict: every property required, no additional properties). */
  schema: Record<string, unknown>;
  /** Directory for temporary files of this run (schema, output). */
  workDir: string;
  model?: string | null | undefined;
  effort?: Effort | undefined;
  accountHome?: string | null | undefined;
  command?: string | undefined;
}

export interface ExecCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Text sent on stdin (the prompt). */
  input: string;
  /** Files to write before running (path -> content). */
  files: Record<string, string>;
  /** File holding the final answer, if the CLI writes one. */
  outputFile: string | null;
}

export interface ProviderCapabilities {
  initialPrompt: boolean;
  modelSelection: boolean;
  resume: boolean;
}

export interface ProviderProbe {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Flags this integration relies on that the installed CLI's --help does not mention. */
  missingFlags: string[];
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly defaultCommand: string;
  readonly capabilities: ProviderCapabilities;
  /** How to install the CLI (shown by `aw doctor` and on spawn failure). */
  readonly installHint: string;
  /** Documentation of the CLI flags we rely on. */
  readonly docsUrl: string;
  /** Flags that should appear in `<cli> --help` for this integration to work. */
  readonly requiredFlags: readonly string[];

  /** Environment variable selecting the account's configuration directory. */
  readonly accountEnvVar: string;
  /** Arguments that start the CLI's own login flow (run interactively with the account's directory). */
  readonly loginArgs: readonly string[];

  isInstalled(command?: string): Promise<boolean>;
  getVersion(command?: string): Promise<string | null>;
  probe(command?: string): Promise<ProviderProbe>;
  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand;
  buildExecCommand(context: ExecContext): ExecCommand;
  /** Extract the JSON answer of an exec run. Throws when there is none. */
  parseExecResult(stdout: string, outputFileContent: string | null): unknown;
}
