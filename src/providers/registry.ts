import { AwError, ExitCode } from '../core/errors.js';
import type { CommandRunner } from '../infrastructure/process/runner.js';
import { ClaudeProvider } from './claude/claude.js';
import { CodexProvider } from './codex/codex.js';
import type { AgentProvider } from './types.js';

/**
 * Provider registry. To add a provider, implement AgentProvider (usually by
 * extending CliProvider) and register it in `createProviderRegistry`.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Provider "${provider.id}" is already registered.`);
    this.providers.set(provider.id, provider);
    return this;
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  all(): AgentProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new AwError(`Unknown provider "${id}".`, {
        exitCode: ExitCode.USAGE,
        hint: `Available providers: ${this.ids().join(', ')}`,
      });
    }
    return provider;
  }
}

export function createProviderRegistry(runner: CommandRunner): ProviderRegistry {
  return new ProviderRegistry().register(new CodexProvider(runner)).register(new ClaudeProvider(runner));
}
