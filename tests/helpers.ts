import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner, RunOptions, RunResult } from '../src/infrastructure/process/runner.js';
import type { Ui } from '../src/infrastructure/terminal/ui.js';
import type { Prompter } from '../src/infrastructure/terminal/prompt.js';

/** Create a fresh temporary directory (canonicalized, e.g. /private/var on macOS). */
export function tempDir(prefix = 'aw-test-'): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Create a repository with one commit on `main`, inside its own parent directory. */
export function createRepo(name = 'project'): { root: string; parent: string } {
  const parent = tempDir();
  const root = path.join(parent, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), '# test\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  return { root, parent };
}

export function commitFile(cwd: string, file: string, content: string, message = `update ${file}`): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

/** Add a bare "origin" remote and push main to it. */
export function addBareRemote(root: string): string {
  const bare = path.join(tempDir('aw-remote-'), 'origin.git');
  git(path.dirname(bare), 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'remote', 'add', 'origin', bare);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return bare;
}

/**
 * Write a fake agent CLI: answers --version/--help like the real one, then
 * records its argv and cwd to a log file and waits for input.
 */
export function fakeAgentCli(dir: string, name: string, helpText: string): { path: string; log: string } {
  const file = path.join(dir, name);
  const log = path.join(dir, `${name}.log`);
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${name} 9.9.9"; exit 0; fi
if [ "$1" = "--help" ]; then echo "${helpText}"; exit 0; fi
{ echo "cwd=$(pwd)"; echo "agent=$AW_AGENT"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; echo "---"; } >> "${log}"
while read line; do
  echo "got: $line"; echo "got: $line" >> "${log}"
  if [ "$line" = "exit" ]; then exit 3; fi
done
`,
  );
  chmodSync(file, 0o755);
  return { path: file, log };
}

export interface CapturedUi extends Ui {
  out: string[];
  err: string[];
  text(): string;
}

export function captureUi(): CapturedUi {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => [...out, ...err].join('\n'),
    line: (t = '') => out.push(t),
    header: (t) => out.push(t),
    kv: (k, v) => out.push(`${k}: ${v}`),
    ok: (t) => out.push(`OK ${t}`),
    fail: (t) => out.push(`FAIL ${t}`),
    warn: (t) => err.push(`WARN ${t}`),
    info: (t) => out.push(`INFO ${t}`),
    hint: (t) => out.push(t),
    error: (t) => err.push(`ERROR ${t}`),
    stderr: (t) => err.push(t),
  };
}

export class ScriptedPrompter implements Prompter {
  readonly questions: string[] = [];
  constructor(private readonly answer: boolean) {}
  async confirm(question: string, options: { assumeYes?: boolean } = {}): Promise<boolean> {
    this.questions.push(question);
    return options.assumeYes ? true : this.answer;
  }
}

/** Mock runner that records calls and returns scripted results. */
export class MockRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: RunOptions }> = [];
  constructor(private readonly respond: (command: string, args: string[]) => Partial<RunResult> = () => ({})) {}
  async run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ command, args: [...args], ...(options ? { options } : {}) });
    const r = this.respond(command, [...args]);
    return { command, args, exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }
  async runInteractive(command: string, args: readonly string[]): Promise<number> {
    this.calls.push({ command, args: [...args] });
    return 0;
  }
}

export function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function killTmuxServer(socket: string): void {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* no server */
  }
  // tmux may leave the socket file behind; remove it (best effort).
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${uid}`, socket), { force: true });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error('Timed out waiting for condition');
}
