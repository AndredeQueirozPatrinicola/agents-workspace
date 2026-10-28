/**
 * Error types and exit codes shared across the application.
 *
 * Every user-facing failure should be an AwError with an actionable `hint`.
 * The CLI layer turns these into a short message and a stable exit code.
 */

export const ExitCode = {
  OK: 0,
  /** Generic failure (a command could not complete). */
  ERROR: 1,
  /** Invalid usage or invalid configuration. */
  USAGE: 2,
  /** A required prerequisite (git, tmux, provider CLI, gh auth) is missing. */
  PREREQUISITE: 3,
  /** A safety check failed (dirty worktree, conflicts in --strict mode, busy lock). */
  UNSAFE: 4,
  /** The user declined a confirmation prompt or interrupted the command. */
  ABORTED: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface AwErrorOptions {
  hint?: string;
  exitCode?: ExitCodeValue;
  cause?: unknown;
  details?: string[];
}

export class AwError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: ExitCodeValue;
  readonly details: string[];

  constructor(message: string, options: AwErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AwError';
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? ExitCode.ERROR;
    this.details = options.details ?? [];
  }
}

export class UserAbortError extends AwError {
  constructor(message = 'Aborted by user.') {
    super(message, { exitCode: ExitCode.ABORTED });
    this.name = 'UserAbortError';
  }
}

export function isAwError(error: unknown): error is AwError {
  return error instanceof AwError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
