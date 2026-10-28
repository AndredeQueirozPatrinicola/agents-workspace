import { CommanderError } from 'commander';
import { buildProgram, formatError } from './program.js';
import type { Deps } from '../core/deps.js';
import { ExitCode, isAwError } from '../core/errors.js';
import { logger } from '../infrastructure/logger.js';
import { colors, ui as defaultUi } from '../infrastructure/terminal/ui.js';

/**
 * Run the CLI and return an exit code instead of exiting, so the whole
 * command surface can be exercised in-process by tests.
 */
export async function runCli(argv: string[], overrides: Partial<Deps> = {}): Promise<number> {
  const ui = overrides.ui ?? defaultUi;
  const context = { exitCode: 0 };
  const program = buildProgram(overrides, context);
  try {
    await program.parseAsync(argv, { from: 'node' });
    return context.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version surface as CommanderErrors with exit code 0.
      return error.exitCode === 0 ? ExitCode.OK : ExitCode.USAGE;
    }
    if (isAwError(error)) {
      const [first, ...rest] = formatError(error);
      ui.error(first ?? error.message);
      for (const line of rest) ui.stderr(line.startsWith('Hint:') ? colors.dim(line) : line);
      if (logger.isDebug() && error.cause) ui.stderr(String(error.cause));
      return error.exitCode;
    }
    ui.stderr(`${colors.red('Unexpected error:')} ${error instanceof Error ? error.message : String(error)}`);
    if (logger.isDebug() && error instanceof Error && error.stack) ui.stderr(error.stack);
    else ui.stderr(colors.dim('Run with --verbose for details.'));
    return ExitCode.ERROR;
  }
}
