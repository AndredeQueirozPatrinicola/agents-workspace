import { spawn } from 'node:child_process';
import { AwError, ExitCode } from '../../core/errors.js';
import { logger } from '../logger.js';

/**
 * Safe child-process execution.
 *
 * All external tools (git, tmux, gh, provider CLIs) are executed with an
 * argument array and `shell: false`, so user-controlled values (branch names,
 * task text, paths) are never interpreted by a shell.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Data written to the child's stdin. */
  input?: string;
  /** Kill the process after this many milliseconds. */
  timeoutMs?: number;
}

export interface RunResult {
  command: string;
  args: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /**
   * Run a command and capture its output. Resolves even when the exit code is
   * non-zero; rejects only when the process cannot be started (e.g. ENOENT).
   */
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** Run a command attached to the current terminal. Resolves with its exit code. */
  runInteractive(command: string, args: readonly string[], options?: RunOptions): Promise<number>;
}

export class CommandNotFoundError extends AwError {
  constructor(readonly command: string, hint?: string) {
    super(`Command not found: ${command}`, {
      exitCode: ExitCode.PREREQUISITE,
      hint: hint ?? `Install "${command}" and make sure it is on your PATH. Run "aw doctor" for details.`,
    });
    this.name = 'CommandNotFoundError';
  }
}

export class CommandFailedError extends AwError {
  constructor(readonly result: RunResult, context?: string) {
    const rendered = renderCommand(result.command, result.args);
    const stderr = result.stderr.trim() || result.stdout.trim();
    super(`${context ? `${context}: ` : ''}command failed (exit ${result.exitCode}): ${rendered}`, {
      details: stderr ? stderr.split('\n').slice(0, 20) : [],
    });
    this.name = 'CommandFailedError';
  }
}

/** Render a command for logs and error messages (display only, never executed). */
export function renderCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(' ');
}

/** Throw a CommandFailedError when the result has a non-zero exit code. */
export function ensureSuccess(result: RunResult, context?: string): RunResult {
  if (result.exitCode !== 0) throw new CommandFailedError(result, context);
  return result;
}

export class NodeCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    logger.debug(`$ ${renderCommand(command, args)}${options.cwd ? `  (cwd: ${options.cwd})` : ''}`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
      }
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (timer) clearTimeout(timer);
        if (error.code === 'ENOENT') reject(new CommandNotFoundError(command));
        else reject(new AwError(`Failed to start ${command}: ${error.message}`, { cause: error }));
      });
      child.on('close', (code, signal) => {
        if (timer) clearTimeout(timer);
        const result: RunResult = {
          command,
          args,
          exitCode: code ?? (signal ? 128 + 15 : 1),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
        if (result.exitCode !== 0) logger.debug(`  -> exit ${result.exitCode}: ${result.stderr.trim().split('\n')[0] ?? ''}`);
        resolve(result);
      });
      child.stdin.on('error', () => {
        /* child may exit before reading stdin; ignore EPIPE */
      });
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  }

  runInteractive(command: string, args: readonly string[], options: RunOptions = {}): Promise<number> {
    logger.debug(`$ ${renderCommand(command, args)} (interactive)`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        stdio: 'inherit',
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') reject(new CommandNotFoundError(command));
        else reject(new AwError(`Failed to start ${command}: ${error.message}`, { cause: error }));
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
  }
}
