import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import { CONFIG_DIR, CONFIG_FILE, TASKS_DIR, configPathFor, parseConfig } from '../config/loader.js';
import { isManagedWorktreeGitDir } from './workspace.js';
import { pathExists, writeFileExclusive } from '../../infrastructure/filesystem/fs.js';
import { readTemplate } from '../../infrastructure/filesystem/package-root.js';

export interface InitOptions {
  name?: string | undefined;
  base?: string | undefined;
  provider?: string | undefined;
  remote?: string | undefined;
}

export interface InitResult {
  configRoot: string;
  configPath: string;
  created: string[];
  projectName: string;
  baseBranch: string;
  provider: string;
}

export function sanitizeProjectName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'project';
}

/** Create `.agents/workspace.yaml`, `.agents/README.md` and `.agents/tasks/`. Never overwrites files. */
export async function initWorkspace(deps: Deps, options: InitOptions = {}): Promise<InitResult> {
  const { git, providers } = deps;
  const repo = await git.detectRepository(deps.cwd);
  if (!repo.toplevel) {
    throw new AwError('Cannot initialize a bare repository directly.', {
      exitCode: ExitCode.USAGE,
      hint: 'Run "aw init" inside one of its working trees.',
    });
  }
  if (await isManagedWorktreeGitDir(repo.gitDir)) {
    throw new AwError('This is an agent worktree managed by Agent Workspace.', {
      exitCode: ExitCode.USAGE,
      hint: 'Run "aw init" in the main repository instead.',
    });
  }
  const root = repo.toplevel;
  const configPath = configPathFor(root);
  if (await pathExists(configPath)) {
    throw new AwError(`Already initialized: ${path.join(CONFIG_DIR, CONFIG_FILE)} exists.`, {
      exitCode: ExitCode.USAGE,
      hint: 'Edit that file to change the configuration, or use "aw add <agent>" to add agents.',
    });
  }

  const remote = options.remote ?? 'origin';
  const projectName = sanitizeProjectName(options.name ?? path.basename(repo.mainWorktree ?? root));
  const baseBranch = options.base ?? (await git.detectDefaultBranch(root, remote));
  let provider = options.provider;
  if (provider) providers.get(provider);
  else {
    provider = 'codex';
    for (const p of providers.all()) {
      if (await p.isInstalled()) {
        provider = p.id;
        break;
      }
    }
  }

  const yaml = readTemplate('workspace.yaml')
    .replaceAll('{{projectName}}', projectName)
    .replaceAll('{{baseBranch}}', baseBranch)
    .replaceAll('{{remote}}', remote)
    .replaceAll('{{provider}}', provider);
  parseConfig(yaml, configPath, providers.ids()); // sanity check before writing

  const created: string[] = [];
  const write = async (rel: string, content: string) => {
    if (await writeFileExclusive(path.join(root, rel), content)) created.push(rel);
  };
  await write(path.join(CONFIG_DIR, CONFIG_FILE), yaml);
  await write(path.join(CONFIG_DIR, 'README.md'), readTemplate('agents-readme.md'));
  await write(path.join(CONFIG_DIR, TASKS_DIR, '.gitkeep'), '');

  return { configRoot: root, configPath, created, projectName, baseBranch, provider };
}
