import os from 'node:os';
import { readFileSync } from 'node:fs';
import type { Deps } from '../deps.js';
import { MERGE_TREE_GIT_VERSION, MIN_GIT_VERSION } from '../git/git.js';
import { MIN_TMUX_VERSION } from '../../infrastructure/terminal/tmux.js';
import { compareVersions } from '../../infrastructure/process/shell.js';
import { openWorkspace } from './workspace.js';
import { errorMessage, isAwError } from '../errors.js';
import { displayPath } from '../../infrastructure/filesystem/fs.js';

/** `aw doctor`: verify prerequisites and the current repository. */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string | undefined;
}

export const MIN_NODE_VERSION = '20.11.0';

export function detectWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function platformLabel(): string {
  if (process.platform === 'darwin') return `macOS ${os.release()}`;
  if (process.platform === 'win32') return 'Windows (native)';
  return detectWsl() ? `Linux (WSL2: ${process.env.WSL_DISTRO_NAME ?? 'unknown distro'})` : `Linux ${os.release()}`;
}

export async function runDoctor(deps: Deps): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // Platform
  if (process.platform === 'win32') {
    add({
      name: 'Platform',
      status: 'fail',
      detail: platformLabel(),
      hint: 'Native Windows is not supported. Install WSL2 (wsl --install) and run Agent Workspace inside your Linux distribution.',
    });
  } else {
    add({ name: 'Platform', status: 'ok', detail: platformLabel() });
  }

  // Node.js
  const node = process.versions.node;
  add(
    compareVersions(node, MIN_NODE_VERSION) >= 0
      ? { name: 'Node.js', status: 'ok', detail: `v${node}` }
      : { name: 'Node.js', status: 'fail', detail: `v${node}`, hint: `Node.js ${MIN_NODE_VERSION}+ is required (22 LTS recommended).` },
  );

  // Git
  const gitVersion = await deps.git.version();
  if (!gitVersion) {
    add({ name: 'git', status: 'fail', detail: 'not found', hint: 'Install Git 2.38 or newer.' });
  } else if (compareVersions(gitVersion, MIN_GIT_VERSION) < 0) {
    add({ name: 'git', status: 'fail', detail: gitVersion, hint: `Git ${MIN_GIT_VERSION}+ is required (2.38+ recommended).` });
  } else if (compareVersions(gitVersion, MERGE_TREE_GIT_VERSION) < 0) {
    add({
      name: 'git',
      status: 'warn',
      detail: gitVersion,
      hint: `Git ${MERGE_TREE_GIT_VERSION}+ enables conflict detection in "aw check".`,
    });
  } else {
    add({ name: 'git', status: 'ok', detail: gitVersion });
  }

  // tmux
  const tmuxVersion = (await deps.terminal.isAvailable()) ? await deps.terminal.version() : null;
  if (!tmuxVersion) {
    add({
      name: 'tmux',
      status: 'fail',
      detail: 'not found',
      hint: 'Install tmux: sudo apt install tmux (Ubuntu/WSL) or brew install tmux (macOS).',
    });
  } else if (compareVersions(tmuxVersion, MIN_TMUX_VERSION) < 0) {
    add({ name: 'tmux', status: 'fail', detail: tmuxVersion, hint: `tmux ${MIN_TMUX_VERSION}+ is required.` });
  } else {
    add({ name: 'tmux', status: 'ok', detail: tmuxVersion });
  }

  // GitHub CLI
  if (!(await deps.github.isInstalled())) {
    add({ name: 'gh (GitHub CLI)', status: 'warn', detail: 'not found', hint: 'Needed for "aw pr". Install from https://cli.github.com/.' });
  } else {
    const version = await deps.github.version();
    const auth = await deps.github.authStatus(deps.cwd).catch(() => ({ ok: false, message: '' }));
    add(
      auth.ok
        ? { name: 'gh (GitHub CLI)', status: 'ok', detail: `${version ?? '?'}, authenticated` }
        : { name: 'gh (GitHub CLI)', status: 'warn', detail: `${version ?? '?'}, not authenticated`, hint: 'Run "gh auth login".' },
    );
  }

  // Providers
  let anyProvider = false;
  for (const provider of deps.providers.all()) {
    const probe = await provider.probe();
    if (!probe.installed) {
      add({ name: `${provider.displayName} (${provider.defaultCommand})`, status: 'warn', detail: 'not found', hint: provider.installHint });
      continue;
    }
    anyProvider = true;
    if (probe.missingFlags.length) {
      add({
        name: `${provider.displayName} (${provider.defaultCommand})`,
        status: 'warn',
        detail: `${probe.version ?? 'unknown version'}; --help does not mention ${probe.missingFlags.join(', ')}`,
        hint: `Update the CLI. See ${provider.docsUrl}`,
      });
    } else {
      add({ name: `${provider.displayName} (${provider.defaultCommand})`, status: 'ok', detail: probe.version ?? 'installed' });
    }
  }
  if (!anyProvider) {
    add({ name: 'Agent providers', status: 'fail', detail: 'no supported agent CLI found', hint: 'Install Codex CLI and/or Claude Code.' });
  }

  // Repository (optional)
  try {
    const ws = await openWorkspace(deps.git, deps.cwd, deps.providers.ids(), deps.env);
    add({ name: 'Repository', status: 'ok', detail: displayPath(ws.configRoot) });
    add({
      name: 'Configuration',
      status: ws.loaded.warnings.length ? 'warn' : 'ok',
      detail: `${Object.keys(ws.config.agents).length} agent(s) configured`,
      hint: ws.loaded.warnings.join(' ') || undefined,
    });
    const onWindowsDrive = detectWsl() && /^\/mnt\/[a-z]\//i.test(ws.workspaceDir);
    add({
      name: 'Worktree directory',
      status: onWindowsDrive ? 'warn' : 'ok',
      detail: displayPath(ws.workspaceDir),
      hint: onWindowsDrive
        ? 'Worktrees on the Windows filesystem (/mnt/c) are slow under WSL2. Keep repositories in the Linux filesystem (e.g. ~/projects).'
        : undefined,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/Not inside a Git repository/.test(message)) {
      add({ name: 'Repository', status: 'ok', detail: 'not inside a repository (skipped)' });
    } else if (/not been initialized/.test(message)) {
      add({ name: 'Repository', status: 'warn', detail: 'not initialized', hint: 'Run "aw init".' });
    } else {
      add({
        name: 'Configuration',
        status: 'fail',
        detail: message,
        hint: isAwError(error) ? [...error.details, error.hint].filter(Boolean).join(' | ') : undefined,
      });
    }
  }

  return checks;
}
