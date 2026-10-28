import { CliProvider, agentEnv } from '../base.js';
import type { AgentLaunchContext, LaunchArg, LaunchCommand } from '../types.js';

/**
 * OpenAI Codex CLI (`codex`).
 *
 * Verified against codex-cli 0.165.0:
 *   codex [OPTIONS] [PROMPT]               interactive TUI, optional first prompt
 *   codex resume --last [OPTIONS]          continue the most recent session (filtered by cwd)
 *   -m, --model <MODEL>                    model selection
 *   -C, --cd <DIR>                         working root
 *
 * Authentication is handled entirely by Codex (`codex login`); Agent
 * Workspace never reads or stores credentials.
 */
export class CodexProvider extends CliProvider {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly defaultCommand = 'codex';
  readonly capabilities = { initialPrompt: true, modelSelection: true, resume: true };
  readonly installHint = 'npm install -g @openai/codex   (then run "codex login")';
  readonly docsUrl = 'https://github.com/openai/codex';
  readonly requiredFlags = ['--model', '--cd', 'resume'] as const;

  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand {
    const args: LaunchArg[] = [];
    if (context.resume) args.push('resume', '--last');
    if (context.model) args.push('--model', context.model);
    args.push('--cd', context.worktreePath);
    args.push(...context.providerArgs, ...context.agentArgs);
    if (!context.resume && context.promptFile) args.push({ fromFile: context.promptFile });
    return {
      command: context.command ?? this.defaultCommand,
      args,
      cwd: context.worktreePath,
      env: agentEnv(context),
    };
  }
}
