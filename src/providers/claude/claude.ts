import { CliProvider, agentEnv } from '../base.js';
import type { AgentLaunchContext, LaunchArg, LaunchCommand } from '../types.js';

/**
 * Anthropic Claude Code (`claude`).
 *
 * Verified against Claude Code 2.1.312:
 *   claude [options] [prompt]      interactive session, optional first prompt
 *   --model <model>                model alias or full name
 *   -c, --continue                 continue the most recent conversation in the current directory
 *
 * Claude Code has no working-directory flag: the session is started with the
 * agent's worktree as its current directory, which also scopes `--continue`
 * to that agent. Authentication is handled by Claude Code itself.
 */
export class ClaudeProvider extends CliProvider {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly defaultCommand = 'claude';
  readonly capabilities = { initialPrompt: true, modelSelection: true, resume: true };
  readonly installHint = 'npm install -g @anthropic-ai/claude-code   (then run "claude" once to sign in)';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code/cli-reference';
  readonly requiredFlags = ['--model', '--continue'] as const;

  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand {
    const args: LaunchArg[] = [];
    if (context.resume) args.push('--continue');
    if (context.model) args.push('--model', context.model);
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
