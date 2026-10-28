import pc from 'picocolors';

/**
 * Human-oriented terminal output. Colors are used sparingly and are disabled
 * automatically when stdout is not a TTY or when NO_COLOR is set
 * (FORCE_COLOR=1 forces them on). Set AW_ASCII=1 for terminals without
 * Unicode symbols.
 */

const colorEnabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
})();

const c = pc.createColors(colorEnabled);
const ascii = process.env.AW_ASCII === '1';

export const symbols = {
  ok: ascii ? '[ok]' : '✓',
  fail: ascii ? '[x]' : '✗',
  warn: ascii ? '[!]' : '!',
  info: ascii ? '-' : '•',
  running: ascii ? '*' : '●',
  stopped: ascii ? 'o' : '○',
  arrowUp: ascii ? '+' : '↑',
  arrowDown: ascii ? '-' : '↓',
};

export const colors = c;

export interface Ui {
  line(text?: string): void;
  header(title: string): void;
  kv(key: string, value: string, width?: number): void;
  ok(text: string): void;
  fail(text: string): void;
  warn(text: string): void;
  info(text: string): void;
  hint(text: string): void;
  error(text: string): void;
  /** Plain line on stderr (error details and hints). */
  stderr(text: string): void;
}

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}

export const ui: Ui = {
  line(text = '') {
    write(process.stdout, text);
  },
  header(title) {
    write(process.stdout, c.bold(title));
    write(process.stdout, '');
  },
  kv(key, value, width = 10) {
    write(process.stdout, `${c.dim(`${key}:`.padEnd(width))} ${value}`);
  },
  ok(text) {
    write(process.stdout, `${c.green(symbols.ok)} ${text}`);
  },
  fail(text) {
    write(process.stdout, `${c.red(symbols.fail)} ${text}`);
  },
  warn(text) {
    // Warnings go to stderr so they remain visible when stdout is piped.
    write(process.stderr, `${c.yellow(symbols.warn)} ${text}`);
  },
  info(text) {
    write(process.stdout, `${c.dim(symbols.info)} ${text}`);
  },
  hint(text) {
    write(process.stdout, c.dim(text));
  },
  error(text) {
    write(process.stderr, `${c.red('Error:')} ${text}`);
  },
  stderr(text) {
    write(process.stderr, text);
  },
};

/** Pad a string to a visible width (ignores ANSI color codes). */
export function padVisible(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/\u001b\[[0-9;]*m/g, '').length;
  return visible >= width ? text : text + ' '.repeat(width - visible);
}

/** Render rows as an aligned table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').replace(/\u001b\[[0-9;]*m/g, '').length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : padVisible(cell, widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [c.dim(fmt(headers)), ...rows.map(fmt)].join('\n');
}
