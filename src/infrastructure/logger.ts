/**
 * Minimal leveled logger. Diagnostic output goes to stderr so that stdout
 * stays clean for machine-readable output (e.g. `aw status --json`).
 *
 * Enable debug output with `--verbose` or `AW_DEBUG=1`.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  private level: Level = process.env.AW_DEBUG && process.env.AW_DEBUG !== '0' ? 'debug' : 'info';

  setLevel(level: Level): void {
    this.level = level;
  }

  isDebug(): boolean {
    return this.level === 'debug';
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  private log(level: Level, message: string): void {
    if (order[level] < order[this.level]) return;
    const prefix = level === 'debug' ? '[aw:debug] ' : '';
    process.stderr.write(`${prefix}${message}\n`);
  }
}

export const logger = new Logger();
