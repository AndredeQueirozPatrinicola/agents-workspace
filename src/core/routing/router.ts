import { AwError, ExitCode } from '../errors.js';
import {
  type Account,
  type Effort,
  type Level,
  type RouteUse,
  type Settings,
  EFFORTS,
  accountAllowed,
} from '../accounts/settings.js';
import type { AccountMark } from '../accounts/state.js';

/**
 * Model router: chooses account, provider, model and effort for a task.
 *
 * It applies the user's rules (settings.yaml) in order, never chooses an
 * account the project does not allow, and always explains its decision.
 * Availability marks only produce warnings: switching to another account
 * is the user's decision.
 */

export interface RouteRequest {
  complexity: Level;
  risk: Level;
  /** The planner's suggestion (used when no rule decides). */
  suggestedProvider?: string | null | undefined;
  suggestedEffort?: Effort | null | undefined;
}

export interface RoutingDecision {
  account: string;
  provider: string;
  model: string | null;
  effort: Effort;
  reason: string;
  warnings: string[];
}

export interface RouterContext {
  settings: Settings;
  accounts: Account[];
  marks: Record<string, AccountMark>;
  /** Project policy (`accounts:` in workspace.yaml): names or tags; null allows every account. */
  policy: string[] | null;
  defaultProvider: string;
}

const LEVEL_RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const EFFORT_BY_LEVEL: Record<Level, Effort> = { low: 'low', medium: 'medium', high: 'high' };

function matches(value: Level, cond: Level | Level[] | undefined): boolean {
  if (cond === undefined) return true;
  return Array.isArray(cond) ? cond.includes(value) : cond === value;
}

export function allowedAccounts(ctx: RouterContext): Account[] {
  return ctx.accounts.filter((a) => accountAllowed(a, ctx.policy));
}

/** Resolve a rule's `use` to an allowed account, or explain why it cannot be used. */
function resolveUse(use: RouteUse, ctx: RouterContext, fallbackProvider: string): { account: Account } | { problem: string } {
  const allowed = allowedAccounts(ctx);
  if (use.account) {
    const account = ctx.accounts.find((a) => a.name === use.account);
    if (!account) return { problem: `account "${use.account}" is not defined` };
    if (!accountAllowed(account, ctx.policy)) return { problem: `account "${use.account}" is not allowed in this project` };
    return { account };
  }
  const provider = use.provider ?? fallbackProvider;
  const account = allowed.find((a) => a.provider === provider && !a.implicit) ?? allowed.find((a) => a.provider === provider);
  if (!account) return { problem: `no allowed account for provider "${provider}"` };
  return { account };
}

function markWarning(account: Account, ctx: RouterContext): string[] {
  const mark = ctx.marks[account.name];
  if (!mark) return [];
  const until = mark.until ? ` until ${new Date(mark.until).toLocaleTimeString()}` : '';
  return [`account ${account.name} is marked limited${until}${mark.note ? ` (${mark.note})` : ''}; switch it with "c" if needed`];
}

export function routeTask(request: RouteRequest, ctx: RouterContext): RoutingDecision {
  const warnings: string[] = [];
  const level: Level = LEVEL_RANK[request.risk] > LEVEL_RANK[request.complexity] ? request.risk : request.complexity;
  const rules = ctx.settings.routing.rules;
  for (const [i, rule] of rules.entries()) {
    if (!matches(request.complexity, rule.when.complexity) || !matches(request.risk, rule.when.risk)) continue;
    const resolved = resolveUse(rule.use, ctx, request.suggestedProvider ?? ctx.defaultProvider);
    if ('problem' in resolved) {
      warnings.push(`rule ${i + 1} skipped: ${resolved.problem}`);
      continue;
    }
    const { account } = resolved;
    const effort = rule.use.effort ?? request.suggestedEffort ?? EFFORT_BY_LEVEL[level];
    const cond = [rule.when.complexity ? `complexity ${[rule.when.complexity].flat().join('/')}` : null, rule.when.risk ? `risk ${[rule.when.risk].flat().join('/')}` : null]
      .filter(Boolean)
      .join(', ');
    return {
      account: account.name,
      provider: account.provider,
      model: rule.use.model ?? null,
      effort,
      reason: `rule ${i + 1}${cond ? ` (${cond})` : ''} → ${account.name}, effort ${effort}`,
      warnings: [...warnings, ...markWarning(account, ctx)],
    };
  }

  // No rule decided: the planner's suggested provider (if an allowed account exists), else the project default.
  const candidates = [request.suggestedProvider, ctx.defaultProvider].filter((p): p is string => Boolean(p));
  for (const provider of candidates) {
    const resolved = resolveUse({ provider }, ctx, provider);
    if ('account' in resolved) {
      const effort = request.suggestedEffort ?? EFFORT_BY_LEVEL[level];
      const why = request.suggestedEffort ? `planner suggestion` : `${level} ${level === request.risk && request.risk !== request.complexity ? 'risk' : 'complexity'}`;
      return {
        account: resolved.account.name,
        provider: resolved.account.provider,
        model: null,
        effort,
        reason: `${rules.length ? 'no rule matched' : 'default policy'}: ${provider === request.suggestedProvider ? 'planner suggested' : 'project default'} ${provider}, effort ${effort} (${why})`,
        warnings: [...warnings, ...markWarning(resolved.account, ctx)],
      };
    }
  }
  const any = allowedAccounts(ctx)[0];
  if (!any) {
    throw new AwError('No account is allowed for this project.', {
      exitCode: ExitCode.USAGE,
      hint: 'Check "accounts:" in .agents/workspace.yaml and the accounts in your settings (aw accounts).',
    });
  }
  const effort = request.suggestedEffort ?? EFFORT_BY_LEVEL[level];
  return {
    account: any.name,
    provider: any.provider,
    model: null,
    effort,
    reason: `only allowed account: ${any.name}, effort ${effort}`,
    warnings: [...warnings, ...markWarning(any, ctx)],
  };
}

/** Route for the planner itself: settings.routing.planner, else the project default provider with high effort. */
export function routePlanner(ctx: RouterContext, override?: { provider?: string | undefined; account?: string | undefined }): RoutingDecision {
  const use: RouteUse = override?.account
    ? { account: override.account }
    : override?.provider
      ? { provider: override.provider }
      : (ctx.settings.routing.planner ?? { provider: ctx.defaultProvider, effort: 'high' });
  const resolved = resolveUse(use, ctx, ctx.defaultProvider);
  if ('problem' in resolved) {
    throw new AwError(`Cannot choose the planner: ${resolved.problem}.`, { exitCode: ExitCode.USAGE, hint: 'Set routing.planner in your settings (aw accounts) or pass --planner.' });
  }
  const effort = use.effort ?? 'high';
  return {
    account: resolved.account.name,
    provider: resolved.account.provider,
    model: use.model ?? null,
    effort,
    reason: ctx.settings.routing.planner && !override ? 'routing.planner' : override ? 'chosen explicitly' : `project default ${ctx.defaultProvider}, effort high`,
    warnings: markWarning(resolved.account, ctx),
  };
}

/** Next allowed account (for cycling in the plan review). */
export function nextAccount(current: string, ctx: RouterContext, delta = 1): Account | null {
  const allowed = allowedAccounts(ctx);
  if (!allowed.length) return null;
  const i = allowed.findIndex((a) => a.name === current);
  return allowed[(i + delta + allowed.length) % allowed.length] ?? null;
}

export function nextEffort(current: Effort, delta = 1): Effort {
  const i = EFFORTS.indexOf(current);
  return EFFORTS[(i + delta + EFFORTS.length) % EFFORTS.length] as Effort;
}
