import path from 'node:path';
import { CliProvider, agentEnv, parseJsonLoose } from '../base.js';
import type { AgentLaunchContext, ExecCommand, ExecContext, LaunchArg, LaunchCommand } from '../types.js';

/**
 * Anthropic Claude Code (`claude`).
 *
 * Verified against Claude Code 2.1.312:
 *   claude [options] [prompt]      interactive session, optional first prompt
 *   --model <model>                model alias or full name
 *   -c, --continue                 continue the most recent conversation in the current directory
 *   --add-dir <directories...>     extra directories the tools may access (variadic: the
 *                                  prompt must therefore follow a "--")
 *   --effort <level>               low, medium, high, xhigh, max
 *   -p --output-format json --json-schema <schema> --permission-mode plan
 *                                  one-shot read-only run; the answer is in "structured_output"
 *   CLAUDE_CONFIG_DIR              configuration (and login) directory of an account
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
  readonly requiredFlags = ['--model', '--continue', '--add-dir'] as const;
  readonly accountEnvVar = 'CLAUDE_CONFIG_DIR';
  /** Claude Code has no login subcommand: it starts and asks to log in (or use /login). */
  readonly loginArgs = [] as const;

  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand {
    const args: LaunchArg[] = [];
    if (context.resume) args.push('--continue');
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('--effort', context.effort);
    for (const dir of context.addDirs) args.push('--add-dir', dir);
    args.push(...context.providerArgs, ...context.agentArgs);
    // "--" ends option parsing, so variadic options (e.g. Claude's --add-dir or
    // --allowedTools) can never swallow the prompt, and a prompt starting with
    // "-" is not mistaken for a flag.
    if (!context.resume && context.promptFile) args.push('--', { fromFile: context.promptFile });
    return {
      command: context.command ?? this.defaultCommand,
      args,
      cwd: context.worktreePath,
      env: { ...agentEnv(context), ...this.accountEnv(context.accountHome) },
    };
  }

  buildExecCommand(context: ExecContext): ExecCommand {
    const args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--json-schema', JSON.stringify(context.schema)];
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('--effort', context.effort);
    return {
      command: context.command ?? this.defaultCommand,
      args,
      cwd: context.cwd,
      env: this.accountEnv(context.accountHome),
      input: context.prompt,
      files: { [path.join(context.workDir, 'prompt.md')]: context.prompt },
      outputFile: null,
    };
  }

  parseExecResult(stdout: string, _outputFileContent?: string | null): unknown {
    const envelope = parseJsonLoose(stdout) as { structured_output?: unknown; result?: unknown; is_error?: boolean; subtype?: string };
    if (envelope.is_error) throw new Error(`Claude Code reported an error (${envelope.subtype ?? 'unknown'}): ${String(envelope.result ?? '').slice(0, 300)}`);
    if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
    if (typeof envelope.result === 'string') return parseJsonLoose(envelope.result);
    throw new Error('Claude Code returned no structured output.');
  }
}
