import { z } from 'zod';

/**
 * Versionable project configuration: `.agents/workspace.yaml`.
 *
 * This file must stay machine-independent: no absolute paths, PIDs, tmux ids
 * or credentials. Machine-specific data lives in the runtime state inside the
 * Git common directory (see core/state).
 */

export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** Names that would be ambiguous with subcommands (e.g. `aw pr status`). */
export const RESERVED_AGENT_NAMES = new Set(['status', 'all', 'dashboard', 'help']);

export const agentNameSchema = z
  .string()
  .regex(
    AGENT_NAME_PATTERN,
    'must be 1-32 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit',
  )
  .refine((name) => !RESERVED_AGENT_NAMES.has(name), {
    message: `is reserved (reserved names: ${[...RESERVED_AGENT_NAMES].join(', ')})`,
  });

const nonEmpty = z.string().trim().min(1, 'must not be empty');

export const agentConfigSchema = z
  .object({
    provider: nonEmpty.optional(),
    branch: nonEmpty.optional(),
    /** Task file, relative to `.agents/`. */
    task: nonEmpty.optional(),
    description: z.string().optional(),
    model: nonEmpty.optional(),
    /** Extra provider CLI arguments, passed verbatim (never through a shell). */
    args: z.array(z.string()).optional(),
    /** Base branch override for this agent. */
    base: nonEmpty.optional(),
    /** Path globs this agent is expected to modify (used for overlap warnings). */
    scope: z.array(nonEmpty).optional(),
    /** Agents whose work this agent depends on. */
    dependsOn: z.array(z.string()).optional(),
  })
  .strict();

export const providerConfigSchema = z
  .object({
    /** Executable name or path (defaults to the provider's standard command). */
    command: nonEmpty.optional(),
    /** Extra arguments added to every launch of this provider. */
    args: z.array(z.string()).optional(),
    /** Default model for this provider. */
    model: nonEmpty.optional(),
  })
  .strict();

export const workspaceConfigSchema = z
  .object({
    version: z.literal(1, { error: 'must be 1 (the only supported configuration version)' }),
    project: z
      .object({
        name: nonEmpty.regex(/^[A-Za-z0-9._-]+$/, 'may only contain letters, digits, ".", "_" and "-"'),
        baseBranch: nonEmpty.default('main'),
        remote: nonEmpty.default('origin'),
      })
      .strict(),
    workspace: z
      .object({
        /** `auto`, a path relative to the repository root, or an absolute/`~` path. */
        directory: nonEmpty.default('auto'),
        terminal: z.enum(['tmux']).default('tmux'),
        /** Prefix for default agent branch names (`<prefix><agent>`). */
        branchPrefix: z.string().default('agent/'),
      })
      .strict()
      .default({ directory: 'auto', terminal: 'tmux', branchPrefix: 'agent/' }),
    defaults: z
      .object({
        provider: nonEmpty.default('codex'),
        createDraftPR: z.boolean().default(true),
        autoCommit: z.boolean().default(false),
        autoMerge: z.literal(false, {
          error: 'must be false: Agent Workspace never merges pull requests automatically',
        }).default(false),
      })
      .strict()
      .default({ provider: 'codex', createDraftPR: true, autoCommit: false, autoMerge: false }),
    providers: z.record(z.string(), providerConfigSchema).default({}),
    agents: z.record(agentNameSchema, agentConfigSchema).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const names = new Set(Object.keys(config.agents));
    for (const [name, agent] of Object.entries(config.agents)) {
      for (const dep of agent.dependsOn ?? []) {
        if (dep === name) {
          ctx.addIssue({ code: 'custom', path: ['agents', name, 'dependsOn'], message: 'an agent cannot depend on itself' });
        } else if (!names.has(dep)) {
          ctx.addIssue({
            code: 'custom',
            path: ['agents', name, 'dependsOn'],
            message: `references unknown agent "${dep}"`,
          });
        }
      }
    }
    const cycle = findDependencyCycle(config.agents);
    if (cycle) {
      ctx.addIssue({ code: 'custom', path: ['agents'], message: `dependency cycle detected: ${cycle.join(' -> ')}` });
    }
  });

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** Returns a dependency cycle (as a list of names) or null. */
export function findDependencyCycle(agents: Record<string, { dependsOn?: string[] | undefined }>): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (name: string): string[] | null => {
    if (done.has(name)) return null;
    if (visiting.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    visiting.add(name);
    stack.push(name);
    for (const dep of agents[name]?.dependsOn ?? []) {
      if (!(dep in agents) || dep === name) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(name);
    done.add(name);
    return null;
  };
  for (const name of Object.keys(agents)) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}
