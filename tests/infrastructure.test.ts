import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CommandFailedError,
  CommandNotFoundError,
  NodeCommandRunner,
  ensureSuccess,
  renderCommand,
} from '../src/infrastructure/process/runner.js';
import { compareVersions, findExecutable, parseVersion, shellQuote } from '../src/infrastructure/process/shell.js';
import { FileLock, isLockStale, withLock } from '../src/infrastructure/filesystem/lock.js';
import { expandHome, isPathInside, writeFileAtomic } from '../src/infrastructure/filesystem/fs.js';
import { tempDir } from './helpers.js';

const runner = new NodeCommandRunner();

describe('NodeCommandRunner', () => {
  it('captures stdout, stderr and exit codes without throwing on failure', async () => {
    const ok = await runner.run('node', ['-e', 'process.stdout.write("out"); process.stderr.write("err")']);
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'out', stderr: 'err' });
    const fail = await runner.run('node', ['-e', 'process.exit(3)']);
    expect(fail.exitCode).toBe(3);
  });

  it('never interprets arguments with a shell', async () => {
    const dir = tempDir();
    const marker = path.join(dir, 'pwned');
    const result = await runner.run('node', ['-e', 'console.log(process.argv[1])', `$(touch ${marker}); echo hi`]);
    expect(result.stdout.trim()).toBe(`$(touch ${marker}); echo hi`);
    expect(existsSync(marker)).toBe(false);
  });

  it('pipes stdin and honours cwd', async () => {
    const dir = tempDir();
    const result = await runner.run('node', ['-e', 'process.stdin.on("data", d => process.stdout.write(process.cwd() + ":" + d))'], {
      cwd: dir,
      input: 'hello',
    });
    expect(result.stdout).toBe(`${dir}:hello`);
  });

  it('reports missing executables as prerequisite errors', async () => {
    const error = await runner.run('definitely-not-a-real-command-aw', []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandNotFoundError);
    expect((error as CommandNotFoundError).exitCode).toBe(3);
  });

  it('kills commands that exceed the timeout', async () => {
    const result = await runner.run('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
  });

  it('turns failed results into errors with stderr details', async () => {
    const result = await runner.run('node', ['-e', 'console.error("boom"); process.exit(2)']);
    expect(() => ensureSuccess(result, 'Doing things')).toThrow(CommandFailedError);
    try {
      ensureSuccess(result, 'Doing things');
    } catch (error) {
      expect((error as CommandFailedError).message).toMatch(/^Doing things: command failed \(exit 2\)/);
      expect((error as CommandFailedError).details).toEqual(['boom']);
    }
  });

  it('renders commands for display', () => {
    expect(renderCommand('git', ['commit', '-m', 'hello world'])).toBe('git commit -m "hello world"');
  });
});

describe('shell helpers', () => {
  it('quotes values safely for POSIX sh', () => {
    for (const value of ["simple", "with space", "it's", '$(rm -rf /)', '`x`', 'a"b', '', 'line\nbreak', "'''"]) {
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
      expect(out).toBe(value);
    }
  });

  it('parses and compares versions', () => {
    expect(parseVersion('git version 2.43.0')).toBe('2.43.0');
    expect(parseVersion('tmux 3.4')).toBe('3.4.0');
    expect(parseVersion('codex-cli 0.165.0')).toBe('0.165.0');
    expect(parseVersion('nothing')).toBeNull();
    expect(compareVersions('2.38.0', '2.31.0')).toBeGreaterThan(0);
    expect(compareVersions('3.0', '3.0.0')).toBe(0);
    expect(compareVersions('2.9.0', '2.10.0')).toBeLessThan(0);
  });

  it('finds executables on PATH', async () => {
    expect(await findExecutable('node')).toMatch(/node$/);
    expect(await findExecutable('no-such-binary-aw')).toBeNull();
  });
});

describe('filesystem helpers', () => {
  it('writes files atomically and expands ~', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'state.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(execFileSync('cat', [file], { encoding: 'utf8' })).toBe('{"a":1}');
    expect(expandHome('~/x')).toBe(path.join(os.homedir(), 'x'));
    expect(isPathInside(path.join(dir, 'nested'), dir)).toBe(true);
    expect(isPathInside(path.dirname(dir), dir)).toBe(false);
  });
});

describe('FileLock', () => {
  it('prevents concurrent management and releases cleanly', async () => {
    const file = path.join(tempDir(), 'agent.lock');
    const lock = await FileLock.acquire(file, { purpose: 'spawn', resource: 'Agent "backend"' });
    await expect(FileLock.acquire(file, { purpose: 'stop', resource: 'Agent "backend"' })).rejects.toMatchObject({
      exitCode: 4,
      message: expect.stringMatching(/Agent "backend" is busy.*"spawn"/),
    });
    await lock.release();
    expect(existsSync(file)).toBe(false);
    await withLock(file, { purpose: 'again' }, async () => expect(existsSync(file)).toBe(true));
    expect(existsSync(file)).toBe(false);
  });

  it('reclaims locks left behind by dead processes', async () => {
    const file = path.join(tempDir(), 'agent.lock');
    writeFileSync(file, JSON.stringify({ pid: 999999, hostname: os.hostname(), purpose: 'spawn', createdAt: '' }));
    expect(isLockStale({ pid: 999999, hostname: os.hostname(), purpose: 'x', createdAt: '' })).toBe(true);
    expect(isLockStale({ pid: process.pid, hostname: os.hostname(), purpose: 'x', createdAt: '' })).toBe(false);
    expect(isLockStale({ pid: 999999, hostname: 'another-host', purpose: 'x', createdAt: '' })).toBe(false);
    const lock = await FileLock.acquire(file, { purpose: 'spawn' });
    await lock.release();
  });

  // Uses the compiled module so real, separate Node processes can import it (run `npm run build` first).
  const distLock = path.resolve(__dirname, '..', 'dist', 'infrastructure', 'filesystem', 'lock.js');
  it.runIf(existsSync(distLock))('guarantees mutual exclusion across concurrent processes', async () => {
    const { spawn } = await import('node:child_process');
    const dir = tempDir();
    const lockFile = path.join(dir, 'state.lock');
    const counter = path.join(dir, 'counter.txt');
    writeFileSync(counter, '0');
    const lockModule = distLock;
    const script = `
      import { withLock } from ${JSON.stringify(lockModule)};
      import { readFileSync, writeFileSync } from 'node:fs';
      for (let i = 0; i < 15; i++) {
        await withLock(${JSON.stringify(lockFile)}, { purpose: 'stress', waitMs: 20000 }, async () => {
          const n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8'));
          await new Promise((r) => setTimeout(r, 2));
          writeFileSync(${JSON.stringify(counter)}, String(n + 1));
        });
      }`;
    const runs = Array.from({ length: 6 }, () =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' });
        child.on('close', (code) => resolve(code ?? 1));
      }),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Number(execFileSync('cat', [counter], { encoding: 'utf8' }))).toBe(90);
  });

  it('never removes a lock that is being written (young and unreadable)', async () => {
    const file = path.join(tempDir(), 'agent.lock');
    writeFileSync(file, '');
    await expect(FileLock.acquire(file, { purpose: 'x' })).rejects.toMatchObject({ exitCode: 4 });
    expect(existsSync(file)).toBe(true);
  });

  it('only releases its own lock', async () => {
    const file = path.join(tempDir(), 'agent.lock');
    const lock = await FileLock.acquire(file, { purpose: 'a' });
    writeFileSync(file, JSON.stringify({ pid: process.pid, hostname: os.hostname(), purpose: 'other', createdAt: 'x', token: 'other' }));
    await lock.release();
    expect(existsSync(file)).toBe(true);
  });

  it('waits for a busy lock when asked to', async () => {
    const file = path.join(tempDir(), 'state.lock');
    const lock = await FileLock.acquire(file, { purpose: 'a' });
    setTimeout(() => void lock.release(), 100);
    const second = await FileLock.acquire(file, { purpose: 'b', waitMs: 2000 });
    await second.release();
  });
});
