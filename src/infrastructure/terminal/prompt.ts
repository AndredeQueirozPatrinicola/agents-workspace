import { createInterface } from 'node:readline/promises';
import { AwError, ExitCode, UserAbortError } from '../../core/errors.js';

/**
 * Confirmation prompts. Destructive or outward-facing operations (removing a
 * worktree, pushing a branch) always go through `confirm`.
 *
 * - `--yes` skips the prompt.
 * - In non-interactive environments (no TTY) without `--yes`, the command
 *   fails instead of silently assuming an answer.
 */

export interface Prompter {
  confirm(question: string, options?: { assumeYes?: boolean; defaultYes?: boolean }): Promise<boolean>;
}

export class TerminalPrompter implements Prompter {
  async confirm(question: string, options: { assumeYes?: boolean; defaultYes?: boolean } = {}): Promise<boolean> {
    if (options.assumeYes) return true;
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AwError(`Confirmation required: ${question}`, {
        exitCode: ExitCode.USAGE,
        hint: 'Re-run with --yes to confirm in non-interactive environments.',
      });
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const suffix = options.defaultYes ? '[Y/n]' : '[y/N]';
      const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
      if (answer === '') return Boolean(options.defaultYes);
      return answer === 'y' || answer === 'yes';
    } finally {
      rl.close();
    }
  }
}

/** Confirm or throw UserAbortError. */
export async function confirmOrAbort(
  prompter: Prompter,
  question: string,
  options: { assumeYes?: boolean; defaultYes?: boolean } = {},
): Promise<void> {
  const ok = await prompter.confirm(question, options);
  if (!ok) throw new UserAbortError();
}
