import path from 'node:path';
import { promises as fsp } from 'node:fs';
import YAML, { isMap } from 'yaml';
import type { z } from 'zod';
import { AwError, ExitCode } from '../errors.js';
import { readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import {
  type AgentConfig,
  type WorkspaceConfig,
  AGENT_NAME_PATTERN,
  RESERVED_AGENT_NAMES,
  workspaceConfigSchema,
} from './schema.js';

export const CONFIG_DIR = '.agents';
export const CONFIG_FILE = 'workspace.yaml';
export const TASKS_DIR = 'tasks';

export function configPathFor(root: string): string {
  return path.join(root, CONFIG_DIR, CONFIG_FILE);
}

export interface LoadedConfig {
  config: WorkspaceConfig;
  /** Absolute path of workspace.yaml. */
  path: string;
  /** Directory containing `.agents/` (the configuration root). */
  root: string;
  warnings: string[];
}

/** An agent with all defaults applied. */
export interface ResolvedAgent {
  name: string;
  provider: string;
  branch: string;
  base: string;
  /** Task file path relative to `.agents/` (may not exist yet). */
  task: string;
  description: string | undefined;
  model: string | undefined;
  args: string[];
  scope: string[];
  dependsOn: string[];
  /** True when the agent is declared in workspace.yaml. */
  configured: boolean;
}

function formatIssues(issues: z.core.$ZodIssue[]): string[] {
  return issues.map((issue) => {
    const where = issue.path.length ? issue.path.map(String).join('.') : '(root)';
    let message = issue.message;
    if (issue.code === 'unrecognized_keys') message = `unknown key(s): ${issue.keys.join(', ')}`;
    if (issue.code === 'invalid_key') message = `invalid agent name: ${issue.issues.map((i) => i.message).join('; ')}`;
    return `${where}: ${message}`;
  });
}

/** Parse and validate configuration text. Throws AwError with per-field details. */
export function parseConfig(
  text: string,
  filePath: string,
  knownProviders: readonly string[],
): { config: WorkspaceConfig; warnings: string[] } {
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new AwError(`Invalid YAML in ${filePath}`, {
      exitCode: ExitCode.USAGE,
      details: doc.errors.map((e) => e.message.split('\n')[0] ?? e.message),
      hint: 'Fix the YAML syntax error above.',
    });
  }
  const raw: unknown = doc.toJS() ?? {};
  const parsed = workspaceConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AwError(`Invalid configuration in ${filePath}`, {
      exitCode: ExitCode.USAGE,
      details: formatIssues(parsed.error.issues),
      hint: 'See "Configuration reference" in the README for the supported fields.',
    });
  }
  const config = parsed.data;
  const errors: string[] = [];
  const known = new Set(knownProviders);
  const checkProvider = (where: string, id: string | undefined) => {
    if (id && !known.has(id)) errors.push(`${where}: unknown provider "${id}" (available: ${knownProviders.join(', ')})`);
  };
  checkProvider('defaults.provider', config.defaults.provider);
  for (const id of Object.keys(config.providers)) checkProvider(`providers.${id}`, id);
  for (const [name, agent] of Object.entries(config.agents)) checkProvider(`agents.${name}.provider`, agent.provider);
  if (errors.length) {
    throw new AwError(`Invalid configuration in ${filePath}`, { exitCode: ExitCode.USAGE, details: errors });
  }

  const warnings: string[] = [];
  if (config.defaults.autoCommit) {
    warnings.push('defaults.autoCommit is not implemented in this version and is ignored; agents commit their own work.');
  }
  const branches = new Map<string, string[]>();
  for (const name of Object.keys(config.agents)) {
    const branch = resolveAgent(config, name).branch;
    branches.set(branch, [...(branches.get(branch) ?? []), name]);
  }
  for (const [branch, names] of branches) {
    if (names.length > 1) {
      warnings.push(
        `Agents ${names.join(', ')} share branch "${branch}". Only one can be spawned at a time (Git allows a branch in one worktree only).`,
      );
    }
  }
  return { config, warnings };
}

export async function loadConfig(root: string, knownProviders: readonly string[]): Promise<LoadedConfig> {
  const file = configPathFor(root);
  const text = await readTextIfExists(file);
  if (text === null) {
    throw new AwError(`No Agent Workspace configuration found (${path.join(CONFIG_DIR, CONFIG_FILE)}).`, {
      exitCode: ExitCode.USAGE,
      hint: 'Run "aw init" in the repository root to create one.',
    });
  }
  const { config, warnings } = parseConfig(text, file, knownProviders);
  return { config, path: file, root, warnings };
}

export function validateAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AwError(`Invalid agent name "${name}".`, {
      exitCode: ExitCode.USAGE,
      hint: 'Use 1-32 lowercase letters, digits, "-" or "_", starting with a letter or digit (e.g. "backend", "auth-api").',
    });
  }
  if (RESERVED_AGENT_NAMES.has(name)) {
    throw new AwError(`"${name}" is a reserved name and cannot be used for an agent.`, { exitCode: ExitCode.USAGE });
  }
}

export interface AgentOverrides {
  provider?: string | undefined;
  branch?: string | undefined;
  model?: string | undefined;
  base?: string | undefined;
  task?: string | undefined;
}

export function resolveAgent(config: WorkspaceConfig, name: string, overrides: AgentOverrides = {}): ResolvedAgent {
  const agent: AgentConfig | undefined = config.agents[name];
  const provider = overrides.provider ?? agent?.provider ?? config.defaults.provider;
  return {
    name,
    provider,
    branch: overrides.branch ?? agent?.branch ?? `${config.workspace.branchPrefix}${name}`,
    base: overrides.base ?? agent?.base ?? config.project.baseBranch,
    task: overrides.task ?? agent?.task ?? `${TASKS_DIR}/${name}.md`,
    description: agent?.description,
    model: overrides.model ?? agent?.model ?? config.providers[provider]?.model,
    args: agent?.args ?? [],
    scope: agent?.scope ?? [],
    dependsOn: agent?.dependsOn ?? [],
    configured: agent !== undefined,
  };
}

/**
 * Add an agent entry to workspace.yaml, preserving existing comments and
 * formatting. Refuses to overwrite an existing entry.
 */
export async function addAgentToConfig(file: string, name: string, agent: AgentConfig): Promise<void> {
  const text = await fsp.readFile(file, 'utf8');
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new AwError(`Cannot update ${file}: invalid YAML.`, { exitCode: ExitCode.USAGE });
  const agents = doc.get('agents');
  if (agents === null || agents === undefined || (isMap(agents) && agents.items.length === 0)) {
    doc.set('agents', doc.createNode({ [name]: agent }));
  } else if (isMap(agents)) {
    if (agents.has(name)) {
      throw new AwError(`Agent "${name}" already exists in ${file}.`, { exitCode: ExitCode.USAGE });
    }
    agents.set(name, doc.createNode(agent));
  } else {
    throw new AwError(`Cannot update ${file}: "agents" must be a mapping.`, { exitCode: ExitCode.USAGE });
  }
  await writeFileAtomic(file, doc.toString({ lineWidth: 0 }));
}
