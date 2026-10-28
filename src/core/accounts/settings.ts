import path from 'node:path';
import YAML, { isMap } from 'yaml';
import { z } from 'zod';
import { AwError, ExitCode } from '../errors.js';
import { AGENT_NAME_PATTERN } from '../config/schema.js';
import { expandHome, readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';

/**
 * Machine-local user settings: `<data dir>/settings.yaml`.
 *
 * Accounts are isolated configuration directories of the provider CLIs
 * (CODEX_HOME for Codex, CLAUDE_CONFIG_DIR for Claude Code). This file only
 * stores *where* they are; logging in is done by the CLIs themselves and
 * Agent Workspace never reads, copies or stores credentials.
 *
 * Routing rules map a task's complexity and risk to an account, model and
 * effort. They are the user's policy; the router only applies them and
 * explains each decision.
 */

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const LEVELS = ['low', 'medium', 'high'] as const;
export type Level = (typeof LEVELS)[number];

export const effortSchema = z.enum(EFFORTS);
export const levelSchema = z.enum(LEVELS);

const accountNameSchema = z.string().regex(AGENT_NAME_PATTERN, 'must be 1-32 lowercase letters, digits, "-" or "_"');

export const accountSchema = z
  .object({
    provider: z.string().min(1),
    /** Configuration directory (CODEX_HOME / CLAUDE_CONFIG_DIR). Omit to use the CLI's default login. */
    home: z.string().min(1).optional(),
    label: z.string().optional(),
    /** Free tags used by project policies, e.g. [work] or [personal]. */
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const routeUseSchema = z
  .object({
    account: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
  })
  .strict();

export const routingRuleSchema = z
  .object({
    when: z
      .object({
        complexity: z.union([levelSchema, z.array(levelSchema)]).optional(),
        risk: z.union([levelSchema, z.array(levelSchema)]).optional(),
      })
      .strict()
      .default({}),
    use: routeUseSchema,
  })
  .strict();

export const settingsSchema = z
  .object({
    accounts: z.record(accountNameSchema, accountSchema).default({}),
    routing: z
      .object({
        planner: routeUseSchema.optional(),
        rules: z.array(routingRuleSchema).default([]),
      })
      .strict()
      .default({ rules: [] }),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;
export type AccountConfig = z.infer<typeof accountSchema>;
export type RouteUse = z.infer<typeof routeUseSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;

/** An account with defaults applied (declared, or the implicit default login of a provider). */
export interface Account {
  name: string;
  provider: string;
  /** Absolute configuration directory, or null for the CLI's default location. */
  home: string | null;
  label: string;
  tags: string[];
  implicit: boolean;
}

export function settingsFile(dataDir: string): string {
  return path.join(dataDir, 'settings.yaml');
}

export const SETTINGS_TEMPLATE = `# Agent Workspace user settings (machine-local; never commit this file).
#
# accounts: isolated logins of the agent CLIs. "home" is the CLI's configuration
# directory (CODEX_HOME for codex, CLAUDE_CONFIG_DIR for claude). Omit it to use
# the CLI's default login. Log in once with: aw accounts login <name>
#
# accounts:
#   codex-personal: { provider: codex, home: ~/.codex-personal, tags: [personal] }
#   codex-work:     { provider: codex, home: ~/.codex, tags: [work] }
#   claude-work:    { provider: claude, home: ~/.claude, tags: [work] }
#
# routing: first matching rule wins; tasks are rated low/medium/high by the planner.
#
# routing:
#   planner: { account: claude-work, effort: high }
#   rules:
#     - when: { risk: high }
#       use: { account: claude-work, effort: high }
#     - when: { complexity: low }
#       use: { account: codex-personal, effort: low }
#     - when: { complexity: [medium, high] }
#       use: { account: codex-work, effort: high }
accounts: {}
`;

export async function loadSettings(dataDir: string): Promise<Settings> {
  const file = settingsFile(dataDir);
  const text = await readTextIfExists(file);
  if (text === null || !text.trim()) return settingsSchema.parse({});
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    throw new AwError(`Invalid YAML in ${file}`, { exitCode: ExitCode.USAGE, details: doc.errors.map((e) => e.message.split('\n')[0] ?? '') });
  }
  const parsed = settingsSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success) {
    throw new AwError(`Invalid settings in ${file}`, {
      exitCode: ExitCode.USAGE,
      details: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** Declared accounts plus one implicit "default login" account per provider (named after it). */
export function resolveAccounts(settings: Settings, providerIds: readonly string[]): Account[] {
  const accounts: Account[] = Object.entries(settings.accounts).map(([name, a]) => ({
    name,
    provider: a.provider,
    home: a.home ? path.resolve(expandHome(a.home)) : null,
    label: a.label ?? name,
    tags: a.tags,
    implicit: false,
  }));
  for (const id of providerIds) {
    if (!accounts.some((a) => a.name === id)) {
      accounts.push({ name: id, provider: id, home: null, label: `${id} (default login)`, tags: [], implicit: true });
    }
  }
  return accounts;
}

export function validateSettings(settings: Settings, providerIds: readonly string[]): string[] {
  const problems: string[] = [];
  const names = new Set(resolveAccounts(settings, providerIds).map((a) => a.name));
  for (const [name, a] of Object.entries(settings.accounts)) {
    if (!providerIds.includes(a.provider)) problems.push(`accounts.${name}.provider: unknown provider "${a.provider}"`);
  }
  const checkUse = (where: string, use: RouteUse | undefined) => {
    if (!use) return;
    if (use.account && !names.has(use.account)) problems.push(`${where}.account: unknown account "${use.account}"`);
    if (use.provider && !providerIds.includes(use.provider)) problems.push(`${where}.provider: unknown provider "${use.provider}"`);
  };
  checkUse('routing.planner', settings.routing.planner);
  settings.routing.rules.forEach((r, i) => checkUse(`routing.rules[${i}].use`, r.use));
  return problems;
}

/** True when the account is allowed by a project policy (list of account names or tags; null allows all). */
export function accountAllowed(account: Account, policy: readonly string[] | null | undefined): boolean {
  if (!policy || policy.length === 0) return true;
  return policy.includes(account.name) || account.tags.some((t) => policy.includes(t));
}

/** Add (or refuse to overwrite) an account in settings.yaml, preserving comments. */
export async function addAccountToSettings(dataDir: string, name: string, account: AccountConfig): Promise<void> {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AwError(`Invalid account name "${name}".`, { exitCode: ExitCode.USAGE, hint: 'Use lowercase letters, digits, "-" or "_" (e.g. codex-work).' });
  }
  const file = settingsFile(dataDir);
  const text = (await readTextIfExists(file)) ?? SETTINGS_TEMPLATE;
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) throw new AwError(`Cannot update ${file}: invalid YAML.`, { exitCode: ExitCode.USAGE });
  const accounts = doc.get('accounts');
  const entry: Record<string, unknown> = { provider: account.provider };
  if (account.home) entry.home = account.home;
  if (account.label) entry.label = account.label;
  if (account.tags.length) entry.tags = account.tags;
  if (isMap(accounts) && accounts.items.length > 0) {
    if (accounts.has(name)) throw new AwError(`Account "${name}" already exists in ${file}.`, { exitCode: ExitCode.USAGE });
    accounts.set(name, doc.createNode(entry));
  } else {
    doc.set('accounts', doc.createNode({ [name]: entry }));
  }
  await writeFileAtomic(file, doc.toString({ lineWidth: 0 }));
}
