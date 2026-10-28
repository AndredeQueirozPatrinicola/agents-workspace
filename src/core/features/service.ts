import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { AwError, ExitCode, errorMessage, isAwError } from '../errors.js';
import type { Deps } from '../deps.js';
import { AgentService } from '../agents/service.js';
import { PrService } from '../github/pr-service.js';
import { AccountService } from '../accounts/service.js';
import { type Effort, EFFORTS, accountAllowed } from '../accounts/settings.js';
import { detectUsageLimit } from '../accounts/state.js';
import { type RoutingDecision, type RouterContext, routePlanner, routeTask } from '../routing/router.js';
import { type Workspace, sessionNameFor } from '../workspace/workspace.js';
import { getSessionState, launchFilesFor } from '../sessions/launcher.js';
import { sharedPaths } from '../files/shared.js';
import { type Plan, renderPlanTask } from './plan.js';
import { buildPlannerPrompt, runPlanner } from './planner.js';
import { taskBranch } from './agents.js';
import {
  type Feature,
  type FeatureEvent,
  type TaskReport,
  type TaskState,
  FeatureStore,
  taskAgentName,
} from './store.js';
import { ensureDir, pathExists, readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';
import { tryWithLock } from '../../infrastructure/filesystem/lock.js';

/**
 * Feature orchestration (ADR 0002):
 *
 *   create → plan (planner agent, read-only) → review (human) → approve
 *     → advance, repeatedly (the conductor):
 *         start tasks whose dependencies are integrated (up to maxParallel)
 *         read status reports (done / blocked) from the agents' outboxes
 *         validate "done" tasks (their commands, in their worktree)
 *         merge validated tasks into the feature branch (integration worktree)
 *         hand merge conflicts back to the task's agent
 *     → ready → pull request (human-confirmed push, never merged automatically)
 *
 * Nothing here force-pushes, rebases, resets or deletes uncommitted work.
 */

export interface CreateFeatureOptions {
  title?: string | undefined;
  planner?: { provider?: string | undefined; account?: string | undefined } | undefined;
}

const VALIDATION_TIMEOUT_MS = 20 * 60_000;
const MAX_VALIDATION_ATTEMPTS = 2;
const MAX_CONFLICT_HANDBACKS = 2;
const OUTPUT_TAIL = 3000;

const tail = (text: string, max = OUTPUT_TAIL) => (text.length > max ? `…${text.slice(-max)}` : text);

export class FeatureService {
  readonly agents: AgentService;
  readonly accounts: AccountService;

  constructor(private readonly deps: Deps) {
    this.agents = new AgentService(deps);
    this.accounts = new AccountService(deps);
  }

  async open(): Promise<{ ws: Workspace; store: FeatureStore }> {
    const ws = await this.agents.open();
    return { ws, store: new FeatureStore(ws.state.dir) };
  }

  private log(store: FeatureStore, id: string, kind: FeatureEvent['kind'], text: string, task?: string): void {
    store.event(id, { kind, text, task });
    const ui = this.deps.ui;
    const line = `[${id}${task ? `/${task}` : ''}] ${text}`;
    if (kind === 'error') ui.error(line);
    else if (kind === 'warn') ui.warn(line);
    else ui.info(line);
  }

  async routerContext(ws: Workspace): Promise<RouterContext> {
    return this.accounts.context(ws.config);
  }

  // ------------------------------------------------------------ create

  async create(request: string, options: CreateFeatureOptions = {}): Promise<Feature> {
    const text = request.trim();
    if (!text) throw new AwError('Describe the feature: the request is empty.', { exitCode: ExitCode.USAGE });
    const { ws, store } = await this.open();
    const cwd = this.agents.repoCwd(ws);
    if (!(await this.deps.git.hasCommits(cwd))) {
      throw new AwError('The repository has no commits yet.', { exitCode: ExitCode.USAGE, hint: 'Commit once (e.g. git add .agents && git commit -m "Add Agent Workspace").' });
    }
    const ctx = await this.routerContext(ws);
    const plannerRoute = routePlanner(ctx, options.planner);
    const firstLine = options.title?.trim() || text.split('\n').find((l) => l.trim())?.trim() || 'feature';
    const id = await store.freeId(firstLine.split(/\s+/).slice(0, 5).join(' '), new Set(Object.keys(ws.config.agents)));
    const now = new Date().toISOString();
    const base = ws.config.project.baseBranch;
    const feature: Feature = {
      version: 1,
      id,
      title: options.title?.trim() || truncateTitle(firstLine),
      request: text,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
      base,
      branch: `${ws.config.features.branchPrefix}${id}`,
      planner: { route: plannerRoute, startedAt: null, finishedAt: null, error: null },
      feedback: [],
      plan: null,
      planWarnings: [],
      tasks: [],
      integrate: ws.config.features.integrate,
      pr: null,
    };
    if (!(await this.deps.git.isValidBranchName(cwd, feature.branch))) {
      throw new AwError(`"${feature.branch}" is not a valid branch name.`, { exitCode: ExitCode.USAGE });
    }
    await store.create(feature);
    this.log(store, id, 'info', `Feature created; planner: ${plannerRoute.account} (${plannerRoute.provider}, effort ${plannerRoute.effort})`);
    return feature;
  }

  // -------------------------------------------------------------- plan

  /** Run the planner in the foreground (used by the CLI and by the background tmux session). */
  async plan(id: string): Promise<Feature> {
    const { ws, store } = await this.open();
    let feature = await store.require(id);
    if (!['planning', 'plan-failed', 'review'].includes(feature.status)) {
      throw new AwError(`Feature "${id}" is ${feature.status}; it can only be planned before approval.`, { exitCode: ExitCode.USAGE });
    }
    feature = await store.update(id, (f) => {
      f.status = 'planning';
      f.planner.startedAt = new Date().toISOString();
      f.planner.finishedAt = null;
      f.planner.error = null;
    });
    const route = feature.planner.route;
    this.log(store, id, 'info', `Planning with ${route.account} (${route.provider}, effort ${route.effort})…`);
    try {
      const account = await this.accounts.forLaunch(route.account, ws.config);
      const provider = this.deps.providers.get(account.provider);
      const providerConfig = ws.config.providers[account.provider] ?? {};
      const prompt = buildPlannerPrompt({
        projectName: ws.projectName,
        baseBranch: feature.base,
        request: feature.request,
        feedback: feature.feedback,
        previousPlan: feature.plan,
        providers: this.deps.providers.ids(),
      });
      const { plan, check } = await runPlanner(this.deps, {
        provider,
        cwd: this.agents.repoCwd(ws),
        workDir: store.plannerDir(id),
        prompt,
        model: route.model ?? providerConfig.model ?? null,
        effort: route.effort,
        accountHome: account.home,
        command: providerConfig.command,
        env: this.deps.env,
        ...(this.deps.env.AW_PLANNER_TIMEOUT_MS ? { timeoutMs: Number(this.deps.env.AW_PLANNER_TIMEOUT_MS) } : {}),
      });
      const ctx = await this.routerContext(ws);
      const updated = await store.update(id, (f) => {
        f.plan = plan;
        f.planWarnings = check.warnings;
        f.title = plan.title;
        f.tasks = plan.tasks.map((t) => this.newTaskState(f, t, ctx));
        f.status = 'review';
        f.planner.finishedAt = new Date().toISOString();
      });
      this.log(store, id, 'success', `Plan ready: ${plan.tasks.length} task(s). Review and approve it.`);
      return updated;
    } catch (error) {
      const message = isAwError(error) ? [error.message, ...error.details.slice(0, 4), error.hint].filter(Boolean).join(' — ') : errorMessage(error);
      await store.update(id, (f) => {
        f.status = 'plan-failed';
        f.planner.error = message;
        f.planner.finishedAt = new Date().toISOString();
      });
      this.log(store, id, 'error', `Planning failed: ${message}`);
      throw error;
    }
  }

  private newTaskState(feature: Feature, task: Plan['tasks'][number], ctx: RouterContext): TaskState {
    const previous = feature.tasks.find((t) => t.id === task.id);
    let route: RoutingDecision;
    try {
      route = routeTask(
        {
          complexity: task.complexity,
          risk: task.risk,
          suggestedProvider: task.suggestedProvider === 'any' ? null : task.suggestedProvider,
          suggestedEffort: task.suggestedEffort,
        },
        ctx,
      );
    } catch (error) {
      route = { account: '', provider: ctx.defaultProvider, model: null, effort: 'medium', reason: errorMessage(error), warnings: [errorMessage(error)] };
    }
    return {
      id: task.id,
      agent: taskAgentName(feature.id, task.id),
      status: 'pending',
      // Keep a route the human changed in a previous review.
      route: previous?.route.reason.startsWith('chosen by you') ? previous.route : route,
      attempts: 0,
      conflicts: 0,
      report: null,
      validation: null,
      attention: null,
      startedAt: null,
      integratedAt: null,
      firstPass: null,
    };
  }

  /** Start the planner in a tmux session, so it survives closing the dashboard. */
  async planInBackground(id: string): Promise<string> {
    const { ws, store } = await this.open();
    await store.require(id);
    const session = sessionNameFor(ws, `-plan-${id}`);
    if (await this.deps.terminal.hasSession(session)) return session;
    await store.update(id, (f) => {
      f.status = 'planning';
      f.planner.startedAt = new Date().toISOString();
      f.planner.error = null;
    });
    await this.deps.terminal.createSession({
      name: session,
      cwd: ws.configRoot,
      command: this.selfCommand(['feature', 'plan', id, '--foreground']),
      windowName: `plan-${id}`,
      tags: { aw_project: ws.projectName, aw_runtime: ws.runtimeId },
    });
    return session;
  }

  private selfCommand(args: string[]): string[] {
    const env = this.deps.env;
    const pass = ['AW_DATA_DIR', 'AW_TMUX_SOCKET', 'AW_WORKSPACE_DIR', 'AW_PLANNER_TIMEOUT_MS', 'AW_CONDUCTOR_INTERVAL_MS']
      .filter((k) => env[k])
      .map((k) => `${k}=${env[k]}`);
    return ['env', `AW_DATA_DIR=${this.deps.dataDir}`, ...pass.filter((p) => !p.startsWith('AW_DATA_DIR=')), ...this.deps.selfCommand, ...args];
  }

  /** Planning whose process disappeared (crash, killed session) becomes plan-failed. */
  async reconcile(): Promise<void> {
    const { ws, store } = await this.open();
    for (const f of await store.list()) {
      if (f.status !== 'planning' || !f.planner.startedAt) continue;
      const session = sessionNameFor(ws, `-plan-${f.id}`);
      const age = Date.now() - new Date(f.planner.startedAt).getTime();
      if (age > 15_000 && !(await this.deps.terminal.hasSession(session))) {
        // The foreground CLI run (aw feature plan) holds no session; only fail when it is clearly gone.
        const log = await readTextIfExists(path.join(store.plannerDir(f.id), 'output.log'));
        if (log !== null || age > 60 * 60_000) {
          await store.update(f.id, (x) => {
            if (x.status !== 'planning') return;
            x.status = 'plan-failed';
            x.planner.error = x.planner.error ?? 'The planner process ended without a plan. Re-plan to try again.';
          });
        }
      }
    }
  }

  async replan(id: string, feedback: string, options: { background?: boolean } = {}): Promise<Feature | string> {
    const { store } = await this.open();
    const f = await store.require(id);
    if (!['review', 'plan-failed', 'planning'].includes(f.status)) {
      throw new AwError(`Feature "${id}" is ${f.status}; re-planning is only possible before approval.`, { exitCode: ExitCode.USAGE });
    }
    if (feedback.trim()) {
      await store.update(id, (x) => {
        x.feedback.push(feedback.trim());
      });
      this.log(store, id, 'info', `Re-planning with feedback: ${feedback.trim()}`);
    }
    return options.background ? this.planInBackground(id) : this.plan(id);
  }

  // ------------------------------------------------------------ review

  /** Change a task's account and/or effort (review, or before the task starts). */
  async setRoute(id: string, taskId: string, change: { account?: string | undefined; effort?: Effort | undefined }): Promise<Feature> {
    const { ws, store } = await this.open();
    const ctx = await this.routerContext(ws);
    let account = null as null | (typeof ctx.accounts)[number];
    if (change.account) {
      account = ctx.accounts.find((a) => a.name === change.account) ?? null;
      if (!account) throw new AwError(`Unknown account "${change.account}".`, { exitCode: ExitCode.USAGE });
      if (!accountAllowed(account, ctx.policy)) throw new AwError(`Account "${change.account}" is not allowed in this project.`, { exitCode: ExitCode.UNSAFE });
    }
    if (change.effort && !EFFORTS.includes(change.effort)) throw new AwError(`Unknown effort "${change.effort}".`, { exitCode: ExitCode.USAGE });
    return store.update(id, (f) => {
      const task = f.tasks.find((t) => t.id === taskId);
      if (!task) throw new AwError(`Unknown task "${taskId}".`, { exitCode: ExitCode.USAGE });
      if (f.status !== 'review' && task.status !== 'pending') {
        throw new AwError(`Task "${taskId}" already started; switch its account with: aw switch ${task.agent} <account>`, { exitCode: ExitCode.USAGE });
      }
      if (account) {
        task.route.account = account.name;
        task.route.provider = account.provider;
        task.route.model = null;
      }
      if (change.effort) task.route.effort = change.effort;
      task.route.reason = `chosen by you: ${task.route.account}, effort ${task.route.effort}`;
      task.route.warnings = ctx.marks[task.route.account] ? [`account ${task.route.account} is marked limited`] : [];
    });
  }

  async skipTask(id: string, taskId: string, skip = true): Promise<Feature> {
    const { store } = await this.open();
    return store.update(id, (f) => {
      if (f.status !== 'review') throw new AwError('Tasks can only be skipped during review.', { exitCode: ExitCode.USAGE });
      const task = f.tasks.find((t) => t.id === taskId);
      if (!task) throw new AwError(`Unknown task "${taskId}".`, { exitCode: ExitCode.USAGE });
      task.status = skip ? 'skipped' : 'pending';
      if (f.tasks.every((t) => t.status === 'skipped')) throw new AwError('At least one task must remain.', { exitCode: ExitCode.USAGE });
    });
  }

  /** The human checkpoint: start execution. */
  async approve(id: string): Promise<Feature> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    if (f.status !== 'review' || !f.plan) {
      throw new AwError(`Feature "${id}" is ${f.status}; only a plan in review can be approved.`, { exitCode: ExitCode.USAGE });
    }
    const unrouted = f.tasks.filter((t) => t.status !== 'skipped' && !t.route.account);
    if (unrouted.length) {
      throw new AwError(`No allowed account for task(s) ${unrouted.map((t) => t.id).join(', ')}.`, {
        exitCode: ExitCode.USAGE,
        hint: 'Choose one in the review (c) or with: aw feature route <feature> <task> --account <name>',
      });
    }
    const taken = new Set(Object.keys(ws.config.agents).filter((n) => !ws.featureAgents[n]));
    const clash = f.tasks.find((t) => taken.has(t.agent));
    if (clash) throw new AwError(`Agent name "${clash.agent}" is already used in workspace.yaml.`, { exitCode: ExitCode.USAGE });

    // Task files, then the feature branch.
    for (const task of f.plan.tasks) {
      await ensureDir(path.dirname(store.taskFile(id, task.id)));
      await writeFileAtomic(store.taskFile(id, task.id), renderPlanTask(task, { title: f.title, summary: f.plan.summary, request: f.request }));
    }
    const cwd = this.agents.repoCwd(ws);
    if (!(await this.deps.git.branchExists(cwd, f.branch))) {
      const baseRef = (await this.agents.comparisonBase(ws, f.base)) ?? f.base;
      await this.deps.git.exec(cwd, ['branch', '--no-track', f.branch, baseRef], 'Creating the feature branch');
      this.log(store, id, 'info', `Feature branch ${f.branch} created from ${baseRef}`);
    }
    const updated = await store.update(id, (x) => {
      x.status = 'running';
      x.integrate = ws.config.features.integrate;
    });
    this.log(store, id, 'success', `Approved: ${updated.tasks.filter((t) => t.status !== 'skipped').length} task(s) will run on ${f.branch}`);
    await this.ensureConductor();
    return updated;
  }

  async cancel(id: string): Promise<Feature> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    for (const task of f.tasks) {
      if (task.status === 'running' || task.status === 'blocked' || task.status === 'attention') {
        await this.agents.stop(task.agent, { yes: true }).catch(() => undefined);
      }
    }
    const session = sessionNameFor(ws, `-plan-${id}`);
    if (await this.deps.terminal.hasSession(session)) await this.deps.terminal.killSession(session);
    const updated = await store.update(id, (x) => {
      x.status = 'cancelled';
    });
    this.log(store, id, 'warn', 'Cancelled. Worktrees and branches are kept (aw feature cleanup removes clean ones).');
    return updated;
  }

  // ------------------------------------------------------------ during execution

  /** Answer a blocked task: the text is typed into the agent and the task resumes. */
  async answer(id: string, taskId: string, text: string): Promise<void> {
    const { store } = await this.open();
    const f = await store.require(id);
    const task = f.tasks.find((t) => t.id === taskId);
    if (!task) throw new AwError(`Unknown task "${taskId}".`, { exitCode: ExitCode.USAGE });
    await this.agents.tell(task.agent, text);
    await store.update(id, (x) => {
      const t = x.tasks.find((y) => y.id === taskId);
      if (t && (t.status === 'blocked' || t.status === 'attention')) {
        t.status = 'running';
        t.attention = null;
      }
    });
    this.log(store, id, 'info', `Answered: ${text}`, taskId);
  }

  /** Put a task that needs attention back to work (after the human fixed things). */
  async retry(id: string, taskId: string): Promise<void> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    const task = f.tasks.find((t) => t.id === taskId);
    if (!task) throw new AwError(`Unknown task "${taskId}".`, { exitCode: ExitCode.USAGE });
    const state = await this.sessionState(ws, task.agent);
    if (state !== 'running') {
      await this.agents.spawn(task.agent, { yes: true, resume: task.startedAt !== null, account: task.route.account || undefined, effort: task.route.effort as Effort });
    }
    await store.update(id, (x) => {
      const t = x.tasks.find((y) => y.id === taskId);
      if (!t) return;
      t.status = t.startedAt ? 'running' : 'pending';
      t.attention = null;
      t.attempts = 0;
      if (!t.startedAt) t.startedAt = new Date().toISOString();
    });
    this.log(store, id, 'info', 'Back to work', taskId);
  }

  /** features.integrate: confirm — merge a validated task now. */
  async integrateNow(id: string, taskId: string): Promise<void> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    const task = f.tasks.find((t) => t.id === taskId);
    if (!task || task.status !== 'validated') throw new AwError(`Task "${taskId}" is not waiting for integration.`, { exitCode: ExitCode.USAGE });
    await this.integrate(ws, store, f, task);
  }

  private async sessionState(ws: Workspace, agent: string) {
    const record = await ws.state.getAgent(agent);
    if (!record?.session) return 'not-spawned' as const;
    return getSessionState(this.deps.terminal, record.session.name, launchFilesFor(ws.state.agentDir(agent)).exitFile);
  }

  private statusFile(ws: Workspace, agent: string): string {
    return path.join(sharedPaths(ws.workspaceDir, agent).outbox, 'status.json');
  }

  /** Read and consume an agent's status report (renamed so it is handled once). */
  private async takeReport(ws: Workspace, agent: string): Promise<TaskReport | { invalid: string } | null> {
    const file = this.statusFile(ws, agent);
    const text = await readTextIfExists(file);
    if (text === null) return null;
    const consumed = file.replace(/status\.json$/, `status.${Date.now()}.json`);
    await fsp.rename(file, consumed).catch(() => undefined);
    try {
      const raw = JSON.parse(text) as { status?: unknown; summary?: unknown; questions?: unknown };
      if (raw.status !== 'done' && raw.status !== 'blocked') return { invalid: `unknown status ${JSON.stringify(raw.status)}` };
      return {
        status: raw.status,
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        questions: Array.isArray(raw.questions) ? raw.questions.map(String) : [],
        at: new Date().toISOString(),
      };
    } catch {
      return { invalid: 'not valid JSON' };
    }
  }

  // ------------------------------------------------------------ advance

  /**
   * One idempotent step of a running feature. Safe to call repeatedly and
   * concurrently (a lock makes concurrent calls no-ops).
   */
  async advance(id: string): Promise<Feature | null> {
    const { store } = await this.open();
    return tryWithLock(store.advanceLock(id), { purpose: 'advance feature', resource: `Feature "${id}"` }, () => this.advanceLocked(id));
  }

  private async advanceLocked(id: string): Promise<Feature> {
    const { ws, store } = await this.open();
    let f = await store.require(id);
    if (f.status !== 'running') return f;
    const maxParallel = ws.config.features.maxParallel;

    for (const snapshot of f.tasks) {
      f = await store.require(id);
      const task = f.tasks.find((t) => t.id === snapshot.id) as TaskState;
      try {
        await this.advanceTask(ws, store, f, task, maxParallel);
      } catch (error) {
        const message = isAwError(error) ? [error.message, error.hint].filter(Boolean).join(' — ') : errorMessage(error);
        await this.needsAttention(store, id, task.id, message);
      }
    }

    f = await store.require(id);
    const live = f.tasks.filter((t) => t.status !== 'skipped');
    if (live.length && live.every((t) => t.status === 'integrated')) {
      f = await store.update(id, (x) => {
        x.status = 'ready';
      });
      await this.writePrFile(store, f);
      this.log(store, id, 'success', `All tasks integrated into ${f.branch}. Review it and open the pull request (aw feature pr ${id}).`);
    }
    return f;
  }

  private async needsAttention(store: FeatureStore, id: string, taskId: string, message: string): Promise<void> {
    let changed = false;
    await store.update(id, (x) => {
      const t = x.tasks.find((y) => y.id === taskId);
      if (!t || (t.status === 'attention' && t.attention === message)) return;
      t.status = 'attention';
      t.attention = message;
      changed = true;
    });
    if (changed) this.log(store, id, 'warn', `Needs you: ${message}`, taskId);
  }

  private async patchTask(store: FeatureStore, id: string, taskId: string, patch: Partial<TaskState>): Promise<void> {
    await store.update(id, (x) => {
      const t = x.tasks.find((y) => y.id === taskId);
      if (t) Object.assign(t, patch);
    });
  }

  private async advanceTask(ws: Workspace, store: FeatureStore, f: Feature, task: TaskState, maxParallel: number): Promise<void> {
    switch (task.status) {
      case 'pending': {
        const planned = f.plan?.tasks.find((t) => t.id === task.id);
        const deps = (planned?.dependsOn ?? []).filter((d) => f.tasks.some((t) => t.id === d && t.status !== 'skipped'));
        if (!deps.every((d) => f.tasks.find((t) => t.id === d)?.status === 'integrated')) return;
        const active = f.tasks.filter((t) => ['running', 'validating', 'blocked', 'attention'].includes(t.status) && t.startedAt).length;
        if (active >= maxParallel) return;
        this.log(store, f.id, 'info', `Starting ${task.agent} (${task.route.account}, effort ${task.route.effort})`, task.id);
        await this.agents.spawn(task.agent, { yes: true, account: task.route.account || undefined, effort: task.route.effort as Effort });
        await this.patchTask(store, f.id, task.id, { status: 'running', startedAt: new Date().toISOString() });
        return;
      }
      case 'running':
      case 'blocked':
      case 'attention': {
        const report = await this.takeReport(ws, task.agent);
        if (report && 'invalid' in report) {
          await this.agents.tell(task.agent, `Your status file was not understood (${report.invalid}). Write valid JSON, e.g. {"status": "done", "summary": "..."}.`).catch(() => undefined);
          return;
        }
        if (report?.status === 'blocked') {
          await this.patchTask(store, f.id, task.id, { status: 'blocked', report, attention: report.questions.join(' · ') || report.summary });
          this.log(store, f.id, 'warn', `Blocked: ${report.questions.join(' · ') || report.summary}`, task.id);
          return;
        }
        if (report?.status === 'done') {
          await this.patchTask(store, f.id, task.id, { status: 'validating', report, attention: null, attempts: task.attempts + 1 });
          this.log(store, f.id, 'info', `Reported done: ${report.summary || '(no summary)'}`, task.id);
          await this.validate(ws, store, f.id, task.id);
          return;
        }
        if (task.status !== 'running') return;
        const state = await this.sessionState(ws, task.agent);
        if (state === 'exited' || state === 'stopped' || state === 'not-spawned') {
          await this.needsAttention(store, f.id, task.id, `the agent ${state === 'exited' ? 'exited' : 'is not running'} without reporting; restart it (r / R) or retry`);
          return;
        }
        const record = await ws.state.getAgent(task.agent);
        if (record?.session) {
          const screen = await this.deps.terminal.capture(record.session.name, 60).catch(() => '');
          const limit = detectUsageLimit(screen);
          if (limit) {
            if (task.route.account) await this.accounts.marks.markLimited(task.route.account, { source: 'detected', note: limit });
            await this.needsAttention(store, f.id, task.id, `usage limit on ${task.route.account || 'its account'}: "${limit}". Switch account (c) to continue with a handoff.`);
          }
        }
        return;
      }
      case 'validating':
        // Interrupted during validation (e.g. the conductor restarted): validate again.
        await this.validate(ws, store, f.id, task.id);
        return;
      default:
        return;
    }
  }

  private async validate(ws: Workspace, store: FeatureStore, id: string, taskId: string): Promise<void> {
    const f = await store.require(id);
    const task = f.tasks.find((t) => t.id === taskId) as TaskState;
    const planned = f.plan?.tasks.find((t) => t.id === taskId);
    const record = await ws.state.getAgent(task.agent);
    if (!record || !(await pathExists(record.worktreePath))) {
      await this.needsAttention(store, id, taskId, 'the task worktree is missing');
      return;
    }
    const wt = record.worktreePath;
    const git = this.deps.git;
    const sendBack = async (message: string, attention: string) => {
      if (task.attempts >= MAX_VALIDATION_ATTEMPTS) {
        await this.needsAttention(store, id, taskId, attention);
        return;
      }
      await this.patchTask(store, id, taskId, { status: 'running' });
      await this.agents.tell(task.agent, message).catch(async () => this.needsAttention(store, id, taskId, `${attention} (and the agent is not running)`));
      this.log(store, id, 'warn', `Sent back: ${attention}`, taskId);
    };

    const status = await git.status(wt);
    if (status.dirty) {
      await sendBack(
        `Your worktree still has uncommitted changes (${status.files.slice(0, 8).join(', ')}). Commit everything that belongs to the task (remove what doesn't), then write the status file again.`,
        'uncommitted changes after "done"',
      );
      return;
    }
    const counts = await git.aheadBehind(this.agents.repoCwd(ws), f.branch, record.branch);
    if (!counts || counts.ahead === 0) {
      await sendBack('There are no commits on your branch yet. Commit your work, then write the status file again.', 'no commits after "done"');
      return;
    }

    const results: string[] = [];
    for (const command of planned?.validation ?? []) {
      this.log(store, id, 'info', `Validating: ${command}`, taskId);
      const r = await this.deps.runner
        .run('/bin/sh', ['-c', command], { cwd: wt, env: { ...this.deps.env, CI: '1' }, timeoutMs: VALIDATION_TIMEOUT_MS })
        .catch((error: unknown) => ({ exitCode: 127, stdout: '', stderr: errorMessage(error) }));
      const output = tail(`${r.stdout}\n${r.stderr}`.trim());
      if (r.exitCode !== 0) {
        await this.patchTask(store, id, taskId, { validation: { ok: false, output: `$ ${command} (exit ${r.exitCode})\n${output}`, at: new Date().toISOString() }, firstPass: task.firstPass ?? false });
        await sendBack(
          `Validation failed: \`${command}\` exited with code ${r.exitCode}. Last output:\n${output.split('\n').slice(-25).join('\n')}\nFix it, commit, run the validation again, then write the status file again.`,
          `validation failed (${command}, exit ${r.exitCode})${task.attempts >= MAX_VALIDATION_ATTEMPTS ? ' twice' : ''}`,
        );
        return;
      }
      results.push(`$ ${command}: ok`);
    }
    await this.patchTask(store, id, taskId, {
      validation: { ok: true, output: results.join('\n') || 'no validation commands', at: new Date().toISOString() },
      firstPass: task.firstPass ?? task.attempts <= 1,
      status: 'validated',
    });
    this.log(store, id, 'success', `Validated${results.length ? ` (${results.length} command(s))` : ' (no commands)'}`, taskId);
    const latest = await store.require(id);
    if (latest.integrate === 'auto') {
      await this.integrate(ws, store, latest, latest.tasks.find((t) => t.id === taskId) as TaskState);
    } else {
      this.log(store, id, 'info', 'Waiting for your confirmation to integrate (features.integrate: confirm).', taskId);
    }
  }

  /** Integration worktree of a feature (checked out on the feature branch, outside the repository). */
  async integrationWorktree(ws: Workspace, f: Feature): Promise<string> {
    const target = path.join(ws.workspaceDir, '.integration', f.id);
    const cwd = this.agents.repoCwd(ws);
    const entries = await this.deps.git.listWorktrees(cwd);
    const existing = entries.find((e) => e.branch === f.branch);
    if (existing) return existing.path;
    await ensureDir(path.dirname(target));
    await this.deps.git.addWorktree(cwd, target, { branch: f.branch });
    return target;
  }

  private async integrate(ws: Workspace, store: FeatureStore, f: Feature, task: TaskState): Promise<void> {
    const git = this.deps.git;
    const wt = await this.integrationWorktree(ws, f);
    if (await git.mergeInProgress(wt)) await git.exec(wt, ['merge', '--abort'], 'Aborting a stale integration merge');
    const status = await git.status(wt);
    if (status.dirty) {
      await this.needsAttention(store, f.id, task.id, `the integration worktree ${wt} has local changes; commit or remove them`);
      return;
    }
    const branch = taskBranch(f.branch, task.id);
    const result = await git.merge(wt, branch);
    if (result.clean) {
      await this.patchTask(store, f.id, task.id, { status: 'integrated', integratedAt: new Date().toISOString(), attention: null });
      this.log(store, f.id, 'success', `Integrated into ${f.branch}`, task.id);
      return;
    }
    // Only the merge we just started is undone; the feature branch is unchanged.
    await git.exec(wt, ['merge', '--abort'], 'Aborting the conflicting integration merge');
    this.log(store, f.id, 'warn', `Conflicts with ${f.branch} in ${result.conflicts.join(', ')}`, task.id);
    if (task.conflicts >= MAX_CONFLICT_HANDBACKS) {
      await this.needsAttention(store, f.id, task.id, `merge conflicts with ${f.branch} again (${result.conflicts.join(', ')}); resolve them yourself or guide the agent`);
      return;
    }
    await this.patchTask(store, f.id, task.id, { status: 'running', conflicts: task.conflicts + 1 });
    try {
      const sync = await this.agents.sync(task.agent, { yes: true, askAgent: true, fetch: false });
      if (sync.merged) {
        await this.agents.tell(task.agent, `I merged ${f.branch} (work from the other tasks) into your branch. Re-run the validation, then write the status file again.`);
      } else if (!sync.conflicts.length) {
        // Already up to date: the conflict must come from somewhere else.
        await this.needsAttention(store, f.id, task.id, `integration conflicts (${result.conflicts.join(', ')}) that a sync did not reproduce`);
      }
    } catch (error) {
      await this.needsAttention(store, f.id, task.id, `merge conflicts with ${f.branch}: ${errorMessage(error)}`);
    }
  }

  private async writePrFile(store: FeatureStore, f: Feature): Promise<void> {
    const lines = [`# ${f.title}`, '', f.plan?.summary ?? '', ''];
    if (f.plan?.approach) lines.push('## Approach', '', f.plan.approach, '');
    lines.push('## Tasks', '');
    for (const t of f.tasks.filter((x) => x.status === 'integrated')) {
      const p = f.plan?.tasks.find((x) => x.id === t.id);
      lines.push(`### ${p?.title ?? t.id}`, '', `Agent \`${t.agent}\` · ${t.route.provider} (${t.route.account}, effort ${t.route.effort})`, '');
      if (t.report?.summary) lines.push(t.report.summary, '');
      if (p?.acceptance.length) lines.push('Acceptance criteria:', ...p.acceptance.map((a) => `- [ ] ${a}`), '');
      if (t.validation?.output) lines.push('Validation:', '```', t.validation.output, '```', '');
    }
    lines.push('## Original request', '', ...f.request.split('\n').map((l) => `> ${l}`), '', '---', 'Planned and executed with [Agent Workspace](https://github.com/) — every task was validated before integration.');
    await writeFileAtomic(store.prFile(f.id), `${lines.join('\n')}\n`);
  }

  // ------------------------------------------------------------ conductor

  conductorSession(ws: Workspace): string {
    return sessionNameFor(ws, '-conductor');
  }

  /** Start the conductor (a tmux session running `aw feature watch`) when features are running. */
  async ensureConductor(): Promise<boolean> {
    const { ws, store } = await this.open();
    const running = (await store.list()).some((f) => f.status === 'running');
    const session = this.conductorSession(ws);
    if (!running || (await this.deps.terminal.hasSession(session))) return false;
    await this.deps.terminal.createSession({
      name: session,
      cwd: ws.configRoot,
      command: this.selfCommand(['feature', 'watch']),
      windowName: 'conductor',
      tags: { aw_project: ws.projectName, aw_runtime: ws.runtimeId },
    });
    return true;
  }

  /** Advance every running feature until none is left. */
  async watch(options: { intervalMs?: number; once?: boolean; signal?: { stopped: boolean } } = {}): Promise<void> {
    const interval = options.intervalMs ?? Number(this.deps.env.AW_CONDUCTOR_INTERVAL_MS || 5000);
    this.deps.ui.info('Conductor started: advancing running features (Ctrl-C stops it; agents keep running).');
    for (;;) {
      const { store } = await this.open();
      const running = (await store.list()).filter((f) => f.status === 'running');
      for (const f of running) await this.advance(f.id).catch((error) => this.deps.ui.error(`[${f.id}] ${errorMessage(error)}`));
      if (options.once || options.signal?.stopped) return;
      if (running.length === 0) {
        this.deps.ui.info('No running features left. Conductor stopped.');
        return;
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ------------------------------------------------------------ pull request

  /** Publish the feature branch as one pull request (push after confirmation; never merged automatically). */
  async pr(id: string, options: { draft?: boolean | undefined; yes?: boolean | undefined; allowSensitive?: boolean | undefined } = {}): Promise<{ url: string; created: boolean }> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    if (f.status !== 'ready' && f.status !== 'pr-open' && f.status !== 'done') {
      const pending = f.tasks.filter((t) => t.status !== 'integrated' && t.status !== 'skipped').map((t) => `${t.id} (${t.status})`);
      throw new AwError(`Feature "${id}" is not ready: ${pending.join(', ') || f.status}.`, { exitCode: ExitCode.USAGE });
    }
    if (!(await pathExists(store.prFile(id)))) await this.writePrFile(store, f);
    const entries = await this.deps.git.listWorktrees(this.agents.repoCwd(ws));
    const result = await new PrService(this.deps, this.agents).publishBranch(ws, {
      label: `feature ${id}`,
      branch: f.branch,
      base: f.base,
      worktree: entries.find((e) => e.branch === f.branch)?.path ?? null,
      title: f.title,
      bodyFile: store.prFile(id),
      body: () => f.plan?.summary ?? f.title,
      draft: options.draft ?? ws.config.defaults.createDraftPR,
      yes: options.yes,
      allowSensitive: options.allowSensitive,
      record: async (pr) => {
        await store.update(id, (x) => {
          x.pr = { number: pr.number, url: pr.url, state: pr.state };
          if (x.status === 'ready') x.status = 'pr-open';
        });
      },
    });
    this.log(store, id, 'success', `Pull request: ${result.url}`);
    return result;
  }

  // ------------------------------------------------------------ cleanup / stats

  /** Remove clean task worktrees and the integration worktree of a finished feature. */
  async cleanup(id: string): Promise<string[]> {
    const { ws, store } = await this.open();
    const f = await store.require(id);
    if (!['ready', 'pr-open', 'done', 'cancelled'].includes(f.status)) {
      throw new AwError(`Feature "${id}" is ${f.status}; clean up after it is ready, published or cancelled.`, { exitCode: ExitCode.USAGE });
    }
    const removed: string[] = [];
    for (const task of f.tasks) {
      if (!(await ws.state.getAgent(task.agent))) continue;
      try {
        await this.agents.stop(task.agent, { yes: true });
        await this.agents.cleanup(task.agent, { yes: true });
        removed.push(task.agent);
      } catch (error) {
        this.log(store, id, 'warn', `Kept ${task.agent}: ${errorMessage(error)}`, task.id);
      }
    }
    const entries = await this.deps.git.listWorktrees(this.agents.repoCwd(ws));
    const integration = entries.find((e) => e.branch === f.branch && e.path.includes(`${path.sep}.integration${path.sep}`));
    if (integration) {
      const r = await this.deps.git.run(this.agents.repoCwd(ws), ['worktree', 'remove', integration.path]);
      if (r.exitCode === 0) removed.push('integration worktree');
    }
    if (f.status === 'ready' || f.status === 'pr-open') {
      await store.update(id, (x) => {
        x.status = 'done';
      });
    }
    return removed;
  }
}

export function truncateTitle(text: string, max = 72): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface RoutingStats {
  key: string;
  tasks: number;
  firstPass: number;
}

/** First-pass validation rate per complexity and effort (the data future routing suggestions will use). */
export function routingStats(features: Feature[]): RoutingStats[] {
  const map = new Map<string, RoutingStats>();
  for (const f of features) {
    for (const t of f.tasks) {
      if (t.firstPass === null) continue;
      const p = f.plan?.tasks.find((x) => x.id === t.id);
      const key = `${p?.complexity ?? '?'} complexity · ${t.route.provider} · effort ${t.route.effort}`;
      const s = map.get(key) ?? { key, tasks: 0, firstPass: 0 };
      s.tasks++;
      if (t.firstPass) s.firstPass++;
      map.set(key, s);
    }
  }
  return [...map.values()].sort((a, b) => b.tasks - a.tasks);
}
