/**
 * Agent provider abstraction.
 *
 * A provider knows how to detect and launch one coding-agent CLI. It never
 * executes the agent itself: it only describes the command. Session backends
 * (tmux) are responsible for running it. This keeps provider code pure and
 * trivially testable, and makes adding a provider a single-file change.
 */

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

  isInstalled(command?: string): Promise<boolean>;
  getVersion(command?: string): Promise<string | null>;
  probe(command?: string): Promise<ProviderProbe>;
  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand;
}
