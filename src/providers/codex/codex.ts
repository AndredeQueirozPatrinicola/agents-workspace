import path from 'node:path';
import { CliProvider, agentEnv, parseJsonLoose } from '../base.js';
import type { AgentLaunchContext, ExecCommand, ExecContext, LaunchArg, LaunchCommand } from '../types.js';
import type { Effort } from '../../core/accounts/settings.js';

/**
 * OpenAI Codex CLI (`codex`).
 *
 * Verified against codex-cli 0.165.0:
 *   codex [OPTIONS] [PROMPT]               interactive TUI, optional first prompt
 *   codex resume --last [OPTIONS]          continue the most recent session (filtered by cwd)
 *   -m, --model <MODEL>                    model selection
 *   -C, --cd <DIR>                         working root
 *   --add-dir <DIR>                        additional writable directory (repeatable)
 *   -c model_reasoning_effort="<level>"    reasoning effort (minimal, low, medium, high, xhigh)
 *   codex exec --sandbox read-only --output-schema <FILE> -o <FILE> -
 *                                          one-shot run; prompt on stdin, final answer in the -o file
 *   CODEX_HOME                             configuration (and login) directory of an account
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
  readonly requiredFlags = ['--model', '--cd', '--add-dir', 'resume'] as const;
  readonly accountEnvVar = 'CODEX_HOME';
  readonly loginArgs = ['login'] as const;

  buildLaunchCommand(context: AgentLaunchContext): LaunchCommand {
    const args: LaunchArg[] = [];
    if (context.resume) args.push('resume', '--last');
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('-c', codexEffort(context.effort));
    args.push('--cd', context.worktreePath);
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
    const schemaFile = path.join(context.workDir, 'schema.json');
    const outputFile = path.join(context.workDir, 'answer.json');
    const args = ['exec', '--sandbox', 'read-only', '--cd', context.cwd, '--skip-git-repo-check', '--output-schema', schemaFile, '-o', outputFile];
    if (context.model) args.push('--model', context.model);
    if (context.effort) args.push('-c', codexEffort(context.effort));
    args.push('-');
    return {
      command: context.command ?? this.defaultCommand,
      args,
      cwd: context.cwd,
      env: this.accountEnv(context.accountHome),
      input: context.prompt,
      files: { [schemaFile]: JSON.stringify(context.schema, null, 2), [path.join(context.workDir, 'prompt.md')]: context.prompt },
      outputFile,
    };
  }

  parseExecResult(stdout: string, outputFileContent: string | null): unknown {
    if (outputFileContent?.trim()) return parseJsonLoose(outputFileContent);
    return parseJsonLoose(stdout);
  }
}

/** Codex has no "max"; it maps to its highest level. */
export function codexEffort(effort: Effort): string {
  return `model_reasoning_effort="${effort === 'max' ? 'xhigh' : effort}"`;
}
