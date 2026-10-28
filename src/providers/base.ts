import type { CommandRunner } from '../infrastructure/process/runner.js';
import { findExecutable, parseVersion } from '../infrastructure/process/shell.js';
import type {
  AgentLaunchContext,
  AgentProvider,
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

  abstract buildLaunchCommand(context: AgentLaunchContext): LaunchCommand;

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

/** Common environment exported into every agent session (no secrets). */
export function agentEnv(context: AgentLaunchContext): Record<string, string> {
  return {
    AW_AGENT: context.agentName,
    AW_PROJECT: context.projectName,
    AW_BRANCH: context.branch,
    AW_WORKTREE: context.worktreePath,
  };
}
