import { createHash } from 'node:crypto';
import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import { type LoadedConfig, configPathFor, loadConfig } from '../config/loader.js';
import type { WorkspaceConfig } from '../config/schema.js';
import { type Git, type RepoInfo } from '../git/git.js';
import { StateStore, WORKTREE_MARKER_FILE } from '../state/runtime-state.js';
import { canonicalPath, expandHome, pathExists } from '../../infrastructure/filesystem/fs.js';
import { type FeatureAgentInfo, loadFeatureAgents } from '../features/agents.js';

/**
 * A resolved workspace: repository + configuration + runtime state.
 *
 * Configuration root resolution (where `.agents/workspace.yaml` is read from):
 *  1. The current working tree, unless it is an agent worktree managed by aw.
 *  2. The repository's main working tree.
 *  3. The config root recorded in runtime state (bare-repository layouts).
 * Running `aw` from inside an agent worktree therefore still manages the
 * whole project consistently.
 */

export interface Workspace {
  repo: RepoInfo;
  configRoot: string;
  loaded: LoadedConfig;
  config: WorkspaceConfig;
  projectName: string;
  /** Absolute directory containing the agent worktrees. */
  workspaceDir: string;
  state: StateStore;
  /** Short stable id of this clone (hash of the common Git dir). */
  runtimeId: string;
  /** Agents defined by features (runtime), merged into `config.agents`. */
  featureAgents: Record<string, FeatureAgentInfo>;
  /** Directories besides `.agents/` that may hold task files (feature task files live in runtime state). */
  taskRoots: string[];
}

export async function isManagedWorktreeGitDir(gitDir: string): Promise<boolean> {
  return pathExists(path.join(gitDir, WORKTREE_MARKER_FILE));
}

export async function locateConfigRoot(repo: RepoInfo, state: StateStore): Promise<string | null> {
  if (repo.toplevel && !(await isManagedWorktreeGitDir(repo.gitDir)) && (await pathExists(configPathFor(repo.toplevel)))) {
    return repo.toplevel;
  }
  if (repo.mainWorktree && (await pathExists(configPathFor(repo.mainWorktree)))) return repo.mainWorktree;
  const recorded = (await state.load()).configRoot;
  if (recorded && (await pathExists(configPathFor(recorded)))) return recorded;
  return null;
}

export function runtimeIdFor(commonDir: string): string {
  return createHash('sha1').update(canonicalPath(commonDir)).digest('hex').slice(0, 6);
}

/**
 * Resolve the worktree directory for this project.
 *  - AW_WORKSPACE_DIR (machine-specific override): `<AW_WORKSPACE_DIR>/<project>`
 *  - `auto`: `<parent of repository>/.agent-workspace/<project>`
 *  - relative paths are resolved from the configuration root; `~` is expanded.
 */
export function resolveWorkspaceDir(
  configRoot: string,
  repo: RepoInfo,
  config: WorkspaceConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.AW_WORKSPACE_DIR?.trim();
  if (override) return path.resolve(expandHome(override), config.project.name);
  const dir = config.workspace.directory;
  if (dir === 'auto') {
    const anchor = repo.mainWorktree ?? (repo.isBare ? repo.commonDir : configRoot);
    return path.join(path.dirname(anchor), '.agent-workspace', config.project.name);
  }
  return path.resolve(configRoot, expandHome(dir));
}

export async function openWorkspace(
  git: Git,
  cwd: string,
  knownProviders: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Workspace> {
  const repo = await git.detectRepository(cwd);
  const state = new StateStore(repo.commonDir);
  const configRoot = await locateConfigRoot(repo, state);
  if (!configRoot) {
    throw new AwError('This repository has not been initialized for Agent Workspace.', {
      exitCode: ExitCode.USAGE,
      hint: 'Run "aw init" in the repository root.',
    });
  }
  const loaded = await loadConfig(configRoot, knownProviders);
  // Feature tasks: defined in runtime state; workspace.yaml wins on a name clash.
  const features = await loadFeatureAgents(state.dir, loaded.config.features.branchPrefix);
  const featureAgents: Record<string, FeatureAgentInfo> = {};
  for (const [name, entry] of Object.entries(features.agents)) {
    if (loaded.config.agents[name]) {
      loaded.warnings.push(`Feature task agent "${name}" is shadowed by an agent with the same name in workspace.yaml.`);
      continue;
    }
    loaded.config.agents[name] = entry;
    featureAgents[name] = features.info[name] as FeatureAgentInfo;
  }
  const current = await state.load();
  if (current.configRoot !== configRoot) {
    await state.update((s) => {
      s.configRoot = configRoot;
    });
  }
  return {
    repo,
    configRoot,
    loaded,
    config: loaded.config,
    projectName: loaded.config.project.name,
    workspaceDir: resolveWorkspaceDir(configRoot, repo, loaded.config, env),
    state,
    runtimeId: runtimeIdFor(repo.commonDir),
    featureAgents,
    taskRoots: [state.dir],
  };
}

function slug(value: string, max: number): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'project';
}

/**
 * tmux session names: `aw-<project>-<clone id>-<agent>`.
 * The clone id keeps two clones of the same project from colliding, and the
 * `aw-` prefix keeps us clear of the user's own sessions.
 */
export function sessionNameFor(ws: Pick<Workspace, 'projectName' | 'runtimeId'>, agent: string): string {
  return `aw-${slug(ws.projectName, 20)}-${ws.runtimeId}-${agent}`;
}

export function dashboardSessionName(ws: Pick<Workspace, 'projectName' | 'runtimeId'>): string {
  return `aw-${slug(ws.projectName, 20)}-${ws.runtimeId}--dashboard`;
}

export function sessionPrefix(ws: Pick<Workspace, 'projectName' | 'runtimeId'>): string {
  return `aw-${slug(ws.projectName, 20)}-${ws.runtimeId}-`;
}

export function worktreePathFor(ws: Pick<Workspace, 'workspaceDir'>, agent: string): string {
  return path.join(ws.workspaceDir, agent);
}
