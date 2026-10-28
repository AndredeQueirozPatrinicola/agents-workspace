import type { CommandRunner } from '../infrastructure/process/runner.js';
import { findExecutable, parseVersion } from '../infrastructure/process/shell.js';
import type {
  AgentLaunchContext,
  AgentProvider,
  ExecCommand,
  ExecContext,
  LaunchCommand,
  ProviderCapabilities,
  ProviderProbe,
} from './types.js';

/** Shared detection logic for providers that are plain CLI executables. */
export abstract class CliProvider implements AgentProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;
  abstract readonly defaultCommand: string;
  abstract readonly capabilities: ProviderCapabilities;
  abstract readonly installHint: string;
  abstract readonly docsUrl: string;
  abstract readonly requiredFlags: readonly string[];

  constructor(protected readonly runner: CommandRunner) {}

  abstract readonly accountEnvVar: string;
  abstract readonly loginArgs: readonly string[];

  abstract buildLaunchCommand(context: AgentLaunchContext): LaunchCommand;
  abstract buildExecCommand(context: ExecContext): ExecCommand;
  abstract parseExecResult(stdout: string, outputFileContent: string | null): unknown;

  /** Account environment (configuration directory), empty for the default login. */
  protected accountEnv(home: string | null | undefined): Record<string, string> {
    return home ? { [this.accountEnvVar]: home } : {};
  }

  async isInstalled(command = this.defaultCommand): Promise<boolean> {
    return (await findExecutable(command)) !== null;
  }

  async getVersion(command = this.defaultCommand): Promise<string | null> {
    try {
      const result = await this.runner.run(command, ['--version'], { timeoutMs: 15_000 });
      if (result.exitCode !== 0) return null;
      return parseVersion(result.stdout || result.stderr);
    } catch {
      return null;
    }
  }

  async probe(command = this.defaultCommand): Promise<ProviderProbe> {
    const path = await findExecutable(command);
    if (!path) return { installed: false, path: null, version: null, missingFlags: [] };
    const version = await this.getVersion(command);
    let missingFlags: string[] = [];
    try {
      const help = await this.runner.run(command, ['--help'], { timeoutMs: 15_000 });
      const text = `${help.stdout}\n${help.stderr}`;
      missingFlags = this.requiredFlags.filter((flag) => !text.includes(flag));
    } catch {
      missingFlags = [];
    }
    return { installed: true, path, version, missingFlags };
  }
}

/** Parse JSON that may be wrapped in a Markdown code fence or surrounded by prose. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('no JSON object found');
}

/** Common environment exported into every agent session (no secrets). */
export function agentEnv(context: AgentLaunchContext): Record<string, string> {
  return {
    AW_AGENT: context.agentName,
    AW_PROJECT: context.projectName,
    AW_BRANCH: context.branch,
    AW_WORKTREE: context.worktreePath,
  };
}
