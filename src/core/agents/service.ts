import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import {
  type ResolvedAgent,
  CONFIG_DIR,
  addAgentToConfig,
  resolveAgent,
  validateAgentName,
} from '../config/loader.js';
import type { AgentConfig } from '../config/schema.js';
import { type AgentRecord } from '../state/runtime-state.js';
import { type TaskFile, loadTask, renderTaskFile, resolveTaskPath } from '../tasks/task.js';
import { buildAgentPrompt, hasActionableTask } from '../tasks/prompt.js';
import { type EnsureWorktreeResult, WorktreeManager } from '../worktrees/manager.js';
import {
  type Workspace,
  openWorkspace,
  sessionNameFor,
  worktreePathFor,
} from '../workspace/workspace.js';
import {
  type SessionState,
  describeLaunch,
  getSessionState,
  launchFilesFor,
  readExitCode,
  writeLaunchFiles,
} from '../sessions/launcher.js';
import type { WorkingTreeStatus } from '../git/git.js';
import { withLock } from '../../infrastructure/filesystem/lock.js';
import { addToInbox, copyLocalFiles, ensureShared, unchangedCopies } from '../files/shared.js';
import { displayPath, isPathInside, pathExists, writeFileExclusive } from '../../infrastructure/filesystem/fs.js';
import { readTemplate } from '../../infrastructure/filesystem/package-root.js';
import { confirmOrAbort } from '../../infrastructure/terminal/prompt.js';
import { colors } from '../../infrastructure/terminal/ui.js';

/**
 * Agent lifecycle: add -> spawn -> (attach | stop | spawn again) -> pr -> cleanup.
 *
 *   spawn    creates/reuses the worktree, writes the launcher, starts tmux
 *   stop     ends the tmux session; worktree, branch and commits are kept
 *   cleanup  removes a clean worktree (never deletes uncommitted work)
 */

export interface AddAgentOptions {
  provider?: string | undefined;
  branch?: string | undefined;
  model?: string | undefined;
  taskText?: string | undefined;
  scope?: string[] | undefined;
  dependsOn?: string[] | undefined;
  description?: string | undefined;
}

export interface SpawnOptions extends AddAgentOptions {
  base?: string | undefined;
  task?: string | undefined;
  prompt?: string | undefined;
  noPrompt?: boolean | undefined;
  resume?: boolean | undefined;
  attach?: boolean | undefined;
  args?: string[] | undefined;
  /** Answer yes to confirmations (adopting an unmarked worktree). */
  yes?: boolean | undefined;
  /** Input files to hand to the agent (copied into its inbox and listed in the prompt). */
  files?: string[] | undefined;
  /** Internal (used by restart): relaunch even if the agent is still running. */
  restartRunning?: boolean | undefined;
}

export interface SpawnResult {
  agent: string;
  sessionName: string;
  worktreePath: string;
  alreadyRunning: boolean;
  promptSent: boolean;
}

export type DependencyState = 'merged' | 'pr-open' | 'in-progress' | 'not-started';

export interface AgentStatus {
  name: string;
  provider: string;
  branch: string;
  base: string;
  configured: boolean;
  spawned: boolean;
  worktreePath: string | null;
  worktreeExists: boolean;
  session: SessionState | 'not-spawned';
  sessionName: string;
  exitCode: number | null;
  changes: Pick<WorkingTreeStatus, 'staged' | 'unstaged' | 'untracked' | 'conflicted'> | null;
  ahead: number | null;
  behind: number | null;
  task: { path: string; title: string | null; exists: boolean; template: boolean };
  description: string | null;
  dependsOn: Array<{ name: string; state: DependencyState }>;
  pr: AgentRecord['pr'] | null;
  lastLaunchAt: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AgentService {
  constructor(private readonly deps: Deps) {}

  open(): Promise<Workspace> {
    return openWorkspace(this.deps.git, this.deps.cwd, this.deps.providers.ids(), this.deps.env);
  }

  repoCwd(ws: Workspace): string {
    return ws.repo.toplevel ?? ws.configRoot;
  }

  private worktrees(ws: Workspace): WorktreeManager {
    return new WorktreeManager(this.deps.git, this.repoCwd(ws));
  }

  private withAgentLock<T>(ws: Workspace, name: string, purpose: string, fn: () => Promise<T>): Promise<T> {
    return withLock(ws.state.agentLockFile(name), { purpose, resource: `Agent "${name}"` }, fn);
  }

  /** Base ref used for comparisons: remote-tracking base if present, else local. */
  async comparisonBase(ws: Workspace, base: string): Promise<string | null> {
    const cwd = this.repoCwd(ws);
    const remote = ws.config.project.remote;
    if (await this.deps.git.remoteBranchExists(cwd, remote, base)) {
      // Prefer whichever is newer: if local base contains the remote one, use local.
      if (await this.deps.git.branchExists(cwd, base)) {
        if (await this.deps.git.isAncestor(cwd, `${remote}/${base}`, base)) return base;
      }
      return `${remote}/${base}`;
    }
    if (await this.deps.git.branchExists(cwd, base)) return base;
    return (await this.deps.git.revParse(cwd, base)) ? base : null;
  }

  // ---------------------------------------------------------------- add

  async add(name: string, options: AddAgentOptions): Promise<{ ws: Workspace; taskCreated: boolean }> {
    validateAgentName(name);
    const ws = await this.open();
    if (ws.config.agents[name]) {
      throw new AwError(`Agent "${name}" is already configured in ${path.join(CONFIG_DIR, 'workspace.yaml')}.`, {
        exitCode: ExitCode.USAGE,
      });
    }
    const taskCreated = await this.addAgentEntry(ws, name, options);
    return { ws: await this.open(), taskCreated };
  }

  private async addAgentEntry(ws: Workspace, name: string, options: AddAgentOptions): Promise<boolean> {
    const provider = options.provider ?? ws.config.defaults.provider;
    this.deps.providers.get(provider); // validates the id
    const branch = options.branch ?? `${ws.config.workspace.branchPrefix}${name}`;
    if (!(await this.deps.git.isValidBranchName(this.repoCwd(ws), branch))) {
      throw new AwError(`"${branch}" is not a valid Git branch name.`, { exitCode: ExitCode.USAGE });
    }
    for (const dep of options.dependsOn ?? []) {
      if (!ws.config.agents[dep]) {
        throw new AwError(`Unknown dependency "${dep}".`, {
          exitCode: ExitCode.USAGE,
          hint: 'Dependencies must be agents configured in workspace.yaml.',
        });
      }
    }
    const entry: AgentConfig = { provider, branch, task: `tasks/${name}.md` };
    if (options.description) entry.description = options.description;
    if (options.model) entry.model = options.model;
    if (options.scope?.length) entry.scope = options.scope;
    if (options.dependsOn?.length) entry.dependsOn = options.dependsOn;
    await addAgentToConfig(ws.loaded.path, name, entry);
    const taskFile = resolveTaskPath(ws.configRoot, entry.task as string);
    const title = options.description ?? name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    return writeFileExclusive(
      taskFile,
      renderTaskFile(readTemplate('task.md'), { agent: name, title, objective: options.taskText, scope: options.scope }),
    );
  }

  // -------------------------------------------------------------- spawn

  async spawn(name: string, options: SpawnOptions = {}): Promise<SpawnResult> {
    validateAgentName(name);
    const { ui, providers, terminal } = this.deps;
    let ws = await this.open();

    ui.header('Agent Workspace');
    let addedToConfig = false;
    let taskCreated = false;
    if (!ws.config.agents[name]) {
      taskCreated = await this.addAgentEntry(ws, name, options);
      addedToConfig = true;
      ws = await this.open();
    }
    const agent = resolveAgent(ws.config, name, {
      provider: options.provider,
      branch: options.branch,
      model: options.model,
      base: options.base,
      task: options.task,
    });
    const provider = providers.get(agent.provider);
    const providerConfig = ws.config.providers[agent.provider] ?? {};
    const command = providerConfig.command ?? provider.defaultCommand;

    ui.kv('Project', ws.projectName);
    ui.kv('Agent', name);
    ui.kv('Provider', provider.displayName + (agent.model ? ` (${agent.model})` : ''));
    ui.kv('Branch', agent.branch);
    ui.line();

    ui.ok('Repository validated');
    ui.ok(addedToConfig ? `Configuration loaded (added "${name}" to .agents/workspace.yaml)` : 'Configuration loaded');
    for (const warning of ws.loaded.warnings) ui.warn(warning);

    for (const warning of configTrustWarnings(agent.provider, providerConfig, agent.args)) ui.warn(warning);

    await terminal.assertUsable();
    if (!(await provider.isInstalled(command))) {
      throw new AwError(`${provider.displayName} CLI not found ("${command}").`, {
        exitCode: ExitCode.PREREQUISITE,
        hint: `Install it: ${provider.installHint}`,
      });
    }

    return this.withAgentLock(ws, name, 'spawn', async () => {
      const sessionName = sessionNameFor(ws, name);
      const existing = await ws.state.getAgent(name);
      // An existing session whose agent has exited (or that `aw restart` asked
      // for) is relaunched in place: same tmux session, so `aw attach` clients
      // and dashboard panes stay connected.
      let relaunchInPlace = false;
      if (await terminal.hasSession(sessionName)) {
        const current = await getSessionState(terminal, sessionName, launchFilesFor(ws.state.agentDir(name)).exitFile);
        if (current === 'running' && !options.restartRunning) {
          ui.info(`Agent "${name}" is already running (tmux session ${sessionName}).`);
          ui.line();
          ui.line('Attach:');
          ui.line(`  aw attach ${name}`);
          ui.line();
          ui.line('Restart it (e.g. after a failed login):');
          ui.line(`  aw restart ${name}`);
          return {
            agent: name,
            sessionName,
            worktreePath: existing?.worktreePath ?? worktreePathFor(ws, name),
            alreadyRunning: true,
            promptSent: false,
          };
        }
        relaunchInPlace = true;
      }
      if (existing && existing.branch !== agent.branch && (await pathExists(existing.worktreePath))) {
        throw new AwError(
          `Agent "${name}" already has a worktree on branch "${existing.branch}", but "${agent.branch}" was requested.`,
          { exitCode: ExitCode.UNSAFE, hint: `Run "aw cleanup ${name}" first, or keep the existing branch.` },
        );
      }

      // 1. Worktree
      const manager = this.worktrees(ws);
      const preferredPath =
        existing && (await manager.findByPath(existing.worktreePath)) ? existing.worktreePath : worktreePathFor(ws, name);
      const wt = await manager.ensure({
        agent: name,
        project: ws.projectName,
        branch: agent.branch,
        base: agent.base,
        remote: ws.config.project.remote,
        path: preferredPath,
        confirmAdopt: async (p) =>
          // A path recorded in our own state is ours (interrupted before the marker was written).
          existing?.worktreePath === p ||
          this.deps.prompter.confirm(
            `A worktree on branch "${agent.branch}" already exists at ${displayPath(p)} but was not created by Agent Workspace. Adopt it for agent "${name}"?`,
            { assumeYes: options.yes },
          ),
      });
      ui.ok(describeWorktree(wt, agent));
      ui.hint(`  ${displayPath(wt.path)}`);
      await this.warnIfWorktreeInsideRepo(ws, wt.path);

      // Local files (.env, ...) and the shared files area.
      const copy = await copyLocalFiles(
        this.deps.git,
        ws.configRoot,
        wt.path,
        ws.config.workspace.copyFiles,
        path.join(ws.state.agentDir(name), 'copied-files.json'),
      );
      if (copy.copied.length) ui.ok(`Local files copied: ${copy.copied.join(', ')}`);
      if (copy.skippedNotIgnored.length) {
        ui.warn(
          `Not copied (not git-ignored, an agent could commit them): ${copy.skippedNotIgnored.join(', ')}. Add them to .gitignore first.`,
        );
      }
      const shared = await ensureShared(ws.workspaceDir, name);
      if (!shared) throw new AwError('Internal error: shared files area not created.');
      const inputs = options.files?.length ? await addToInbox(options.files.map((f) => path.resolve(this.deps.cwd, f)), shared.agentInbox) : [];
      if (inputs.length) ui.ok(`Input files: ${inputs.map((f) => path.basename(f)).join(', ')}`);

      const now = new Date().toISOString();
      await ws.state.upsertAgent({
        ...(existing ?? {}),
        name,
        provider: agent.provider,
        branch: agent.branch,
        base: agent.base,
        worktreePath: wt.path,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      // 2. Safety checks (advisory)
      await this.spawnSafetyWarnings(ws, agent);
      const dependencies = await this.dependencyStates(ws, agent);
      for (const dep of dependencies) {
        if (dep.state !== 'merged') {
          ui.warn(`Depends on "${dep.name}" (${dep.state.replace('-', ' ')}). Coordinate on shared contracts before relying on its code.`);
        }
      }

      // 3. Task and prompt
      const task = await loadTask(ws.configRoot, agent.task);
      const sendPrompt = !options.noPrompt && !options.resume && hasActionableTask(task, agent, options.prompt);
      if (task && !task.isTemplate) ui.ok(`Task loaded (${task.relativePath})`);
      else if (task?.isTemplate) {
        ui.warn(
          `Task file ${task.relativePath} is still a template${taskCreated ? ' (just created)' : ''}; ${sendPrompt ? 'only the extra instructions are sent' : 'the agent starts without a task prompt'}.`,
        );
      } else ui.warn(`Task file .agents/${agent.task} not found; the agent starts without a task prompt.`);

      let prompt: string | null = null;
      if (sendPrompt) {
        const config = ws.config;
        const others = Object.keys(config.agents)
          .filter((n) => n !== name)
          .map((n) => resolveAgent(config, n))
          .map((a) => ({ name: a.name, branch: a.branch, scope: a.scope }));
        prompt = buildAgentPrompt({
          projectName: ws.projectName,
          agent,
          worktreePath: wt.path,
          task,
          dependencies: dependencies.map((d) => ({
            name: d.name,
            branch: resolveAgent(config, d.name).branch,
            merged: d.state === 'merged',
          })),
          otherAgents: others,
          extraInstructions: options.prompt,
          files: { inbox: shared.inbox, agentInbox: shared.agentInbox, outbox: shared.outbox, inputs },
        });
      } else if (inputs.length && options.resume) {
        ui.info(`Resuming: tell the agent about the new files, e.g. aw tell ${name} "New input files in ${displayPath(shared.agentInbox)}"`);
      }

      // 4. Session
      const files = launchFilesFor(ws.state.agentDir(name));
      const launch = provider.buildLaunchCommand({
        agentName: name,
        projectName: ws.projectName,
        worktreePath: wt.path,
        branch: agent.branch,
        promptFile: prompt !== null ? files.prompt : null,
        model: agent.model,
        providerArgs: providerConfig.args ?? [],
        agentArgs: [...agent.args, ...(options.args ?? [])],
        resume: Boolean(options.resume),
        addDirs: [shared.root],
        command: providerConfig.command,
      });
      await writeLaunchFiles(files, launch, { agent: name, providerName: provider.displayName }, prompt);
      if (relaunchInPlace) {
        await terminal.respawn(sessionName, wt.path, ['/bin/sh', files.script]);
        ui.ok(`Agent relaunched in its existing tmux session (${sessionName}); attached terminals and dashboard panes stay connected`);
      } else {
        await terminal.createSession({
          name: sessionName,
          cwd: wt.path,
          command: ['/bin/sh', files.script],
          windowName: name,
          tags: { aw_agent: name, aw_project: ws.projectName, aw_runtime: ws.runtimeId },
        });
        ui.ok(`tmux session created (${sessionName})`);
      }

      await ws.state.patchAgent(name, {
        session: { backend: 'tmux', name: sessionName, startedAt: new Date().toISOString() },
        lastLaunch: { at: new Date().toISOString(), command: describeLaunch(launch), resumed: Boolean(options.resume) },
      });

      ui.line();
      ui.line(options.resume ? 'Agent resumed successfully.' : 'Agent started successfully.');
      ui.line();
      ui.line('Attach:');
      ui.line(`  aw attach ${name}`);
      ui.line();
      ui.line('Status:');
      ui.line('  aw status');
      if (options.attach) {
        if (!process.stdout.isTTY) ui.warn('Not attaching: no interactive terminal.');
        else await terminal.attach(sessionName);
      }
      return { agent: name, sessionName, worktreePath: wt.path, alreadyRunning: false, promptSent: prompt !== null };
    });
  }

  private async warnIfWorktreeInsideRepo(ws: Workspace, worktreePath: string): Promise<void> {
    const root = ws.repo.toplevel ?? ws.configRoot;
    if (!isPathInside(worktreePath, root)) return;
    const rel = path.relative(root, ws.workspaceDir);
    if (!(await this.deps.git.isIgnored(root, rel))) {
      this.deps.ui.warn(`Worktrees are inside the repository (${rel}/) but not ignored. Add "${rel}/" to .gitignore.`);
    }
  }

  private async spawnSafetyWarnings(ws: Workspace, agent: ResolvedAgent): Promise<void> {
    const base = await this.comparisonBase(ws, agent.base);
    if (!base) return;
    const counts = await this.deps.git.aheadBehind(this.repoCwd(ws), base, agent.branch);
    if (counts && counts.behind > 0) {
      this.deps.ui.warn(
        `${agent.branch} is ${counts.behind} commit(s) behind ${base}. Consider updating it (e.g. merge ${base}) before continuing work.`,
      );
    }
  }

  async dependencyStates(ws: Workspace, agent: ResolvedAgent): Promise<Array<{ name: string; state: DependencyState }>> {
    const state = await ws.state.load();
    const cwd = this.repoCwd(ws);
    const result: Array<{ name: string; state: DependencyState }> = [];
    for (const dep of agent.dependsOn) {
      const depAgent = resolveAgent(ws.config, dep);
      const pr = state.prs?.[dep] ?? state.agents[dep]?.pr;
      let depState: DependencyState;
      if (pr?.state === 'MERGED') depState = 'merged';
      else if (pr?.state === 'OPEN') depState = 'pr-open';
      else if (
        (await this.deps.git.branchExists(cwd, depAgent.branch)) ||
        (await this.deps.git.remoteBranchExists(cwd, ws.config.project.remote, depAgent.branch))
      ) depState = 'in-progress';
      else depState = 'not-started';
      result.push({ name: dep, state: depState });
    }
    return result;
  }

  // ------------------------------------------------------------ restart

  /**
   * Restart an agent in place. A running agent is interrupted first (after
   * confirmation); the tmux session is reused so dashboard panes survive.
   */
  async restart(name: string, options: SpawnOptions = {}): Promise<SpawnResult> {
    validateAgentName(name);
    const ws = await this.open();
    const record = await ws.state.getAgent(name);
    const sessionName = record?.session?.name ?? sessionNameFor(ws, name);
    const files = launchFilesFor(ws.state.agentDir(name));
    if ((await this.deps.terminal.hasSession(sessionName)) && (await getSessionState(this.deps.terminal, sessionName, files.exitFile)) === 'running') {
      await confirmOrAbort(this.deps.prompter, `Agent "${name}" is running. Interrupt and restart it? (worktree, branch and commits are kept)`, {
        assumeYes: options.yes,
      });
      await this.withAgentLock(ws, name, 'restart', () => this.interrupt(sessionName, files.exitFile));
    }
    return this.spawn(name, { ...options, restartRunning: true });
  }

  // --------------------------------------------------------------- tell

  /**
   * Type a message into a running agent's TUI and press Enter. Refused when
   * the agent has exited, because the pane then holds a shell and the text
   * would be executed as a command.
   */
  async tell(name: string, message: string): Promise<void> {
    validateAgentName(name);
    const text = message.replace(/\s*\r?\n\s*/g, ' ').trim();
    if (!text) throw new AwError('Nothing to send: the message is empty.', { exitCode: ExitCode.USAGE });
    const ws = await this.open();
    const record = await ws.state.getAgent(name);
    const sessionName = record?.session?.name ?? sessionNameFor(ws, name);
    const state = await getSessionState(this.deps.terminal, sessionName, launchFilesFor(ws.state.agentDir(name)).exitFile);
    if (state !== 'running') {
      throw new AwError(`Agent "${name}" is not running (${state}); refusing to type into its terminal.`, {
        exitCode: ExitCode.UNSAFE,
        hint: `Start it first: aw restart ${name} --resume`,
      });
    }
    await this.deps.terminal.sendText(sessionName, text);
    this.deps.ui.ok(`Sent to "${name}": ${text.length > 100 ? `${text.slice(0, 99)}…` : text}`);
  }

  // --------------------------------------------------------------- sync

  /**
   * Bring the base branch into an agent's branch with a normal `git merge`
   * inside its worktree (never rebase, never force). Conflicts are left in
   * place for a human or the agent to resolve; nothing is auto-resolved.
   */
  async sync(
    name: string,
    options: { yes?: boolean | undefined; askAgent?: boolean | undefined; fetch?: boolean | undefined } = {},
  ): Promise<{ merged: boolean; conflicts: string[]; upToDate: boolean }> {
    validateAgentName(name);
    const { ui, git, terminal } = this.deps;
    const ws = await this.open();
    const record = await ws.state.getAgent(name);
    if (!record || !(await pathExists(record.worktreePath))) {
      throw new AwError(`Agent "${name}" has no worktree.`, { exitCode: ExitCode.USAGE, hint: `Spawn it first: aw spawn ${name}` });
    }
    const wt = record.worktreePath;
    const sessionName = record.session?.name ?? sessionNameFor(ws, name);
    const agentState = await getSessionState(terminal, sessionName, launchFilesFor(ws.state.agentDir(name)).exitFile);
    if (options.askAgent && agentState !== 'running') {
      throw new AwError(`--ask-agent needs "${name}" to be running (it is ${agentState}).`, {
        exitCode: ExitCode.USAGE,
        hint: `Start it with "aw restart ${name} --resume", or sync without --ask-agent.`,
      });
    }

    return this.withAgentLock(ws, name, 'sync', async () => {
      const cwd = this.repoCwd(ws);
      const remote = ws.config.project.remote;
      if (options.fetch !== false && (await git.remoteExists(cwd, remote))) {
        const fetched = await git.fetch(cwd, remote, [record.base]);
        if (fetched.exitCode !== 0) ui.warn(`Could not fetch ${remote}/${record.base}; using the local copy.`);
      }
      if (await git.mergeInProgress(wt)) {
        throw new AwError(`A merge is already in progress in ${displayPath(wt)}.`, {
          exitCode: ExitCode.UNSAFE,
          hint: `Finish it (resolve, "git add", "git commit") or abort it with "git -C ${wt} merge --abort".`,
        });
      }
      const status = await git.status(wt);
      if (status.dirty) {
        throw new AwError(`"${name}" has uncommitted changes; commit them before syncing.`, {
          exitCode: ExitCode.UNSAFE,
          details: status.files.slice(0, 15),
          hint: agentState === 'running' ? `Ask the agent: aw tell ${name} "Commit your current work with a clear message."` : undefined,
        });
      }
      const base = await this.comparisonBase(ws, record.base);
      if (!base) throw new AwError(`Base branch "${record.base}" not found.`, { exitCode: ExitCode.USAGE });
      const counts = await git.aheadBehind(cwd, base, record.branch);
      if (counts && counts.behind === 0) {
        ui.ok(`${record.branch} is already up to date with ${base}.`);
        return { merged: false, conflicts: [], upToDate: true };
      }
      if (agentState === 'running') {
        await confirmOrAbort(
          this.deps.prompter,
          `Merge ${counts?.behind ?? 'new'} commit(s) from ${base} into ${record.branch} while "${name}" is running?`,
          { assumeYes: options.yes, defaultYes: true },
        );
      }
      const result = await git.merge(wt, base);
      if (result.clean) {
        ui.ok(`Merged ${base} into ${record.branch} (${counts?.behind ?? '?'} commit(s)).`);
        if (agentState === 'running') {
          ui.info(`Tip: aw tell ${name} "I merged ${base} into your branch; re-run the tests."`);
        }
        return { merged: true, conflicts: [], upToDate: false };
      }
      ui.warn(`Merging ${base} into ${record.branch} produced conflicts in ${result.conflicts.length} file(s):`);
      for (const f of result.conflicts) ui.warn(`  ${f}`);
      if (options.askAgent) {
        await terminal.sendText(
          sessionName,
          `I merged ${base} into your branch ${record.branch} and it has merge conflicts in: ${result.conflicts.join(', ')}. ` +
            'Resolve them keeping the intent of both sides (read both versions and the related code), run the validation/tests, then stage the files and commit the merge. Do not abort the merge and do not rebase.',
        );
        ui.ok(`Asked "${name}" to resolve the conflicts. Watch it with: aw attach ${name}`);
      } else {
        ui.line();
        ui.line('The merge is paused with conflict markers in the worktree. Choose one:');
        ui.line(`  aw tell ${name} "Resolve the merge conflicts, run the tests and commit the merge"   # let the agent do it`);
        ui.line(`  cd ${displayPath(wt)}   # resolve yourself (editor / git mergetool), then: git add <files> && git commit`);
        ui.line(`  git -C ${displayPath(wt)} merge --abort   # undo the merge`);
      }
      return { merged: false, conflicts: result.conflicts, upToDate: false };
    });
  }

  // --------------------------------------------------------------- edit

  /** Path of an agent's task file, creating it from the template if missing. */
  async taskFileFor(name: string): Promise<{ path: string; created: boolean }> {
    validateAgentName(name);
    const ws = await this.open();
    if (!ws.config.agents[name]) {
      throw new AwError(`Agent "${name}" is not configured.`, {
        exitCode: ExitCode.USAGE,
        hint: `Add it first: aw add ${name} --provider codex|claude`,
      });
    }
    const agent = resolveAgent(ws.config, name);
    const file = resolveTaskPath(ws.configRoot, agent.task);
    const title = agent.description ?? name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const created = await writeFileExclusive(file, renderTaskFile(readTemplate('task.md'), { agent: name, title }));
    return { path: file, created };
  }

  // --------------------------------------------------------------- stop

  async stop(name: string, options: { yes?: boolean | undefined } = {}): Promise<void> {
    validateAgentName(name);
    const { ui, terminal } = this.deps;
    const ws = await this.open();
    await this.withAgentLock(ws, name, 'stop', async () => {
      const record = await ws.state.getAgent(name);
      const sessionName = record?.session?.name ?? sessionNameFor(ws, name);
      if (!(await terminal.hasSession(sessionName))) {
        ui.info(`Agent "${name}" is not running.`);
        if (record?.session) await ws.state.patchAgent(name, { session: undefined });
        return;
      }
      const files = launchFilesFor(ws.state.agentDir(name));
      const state = await getSessionState(terminal, sessionName, files.exitFile);
      if (state === 'running') {
        await confirmOrAbort(
          this.deps.prompter,
          `Agent "${name}" is still running. Interrupt it and close its tmux session? (worktree, branch and commits are kept)`,
          { assumeYes: options.yes },
        );
        await this.interrupt(sessionName, files.exitFile);
      }
      await terminal.killSession(sessionName);
      await ws.state.patchAgent(name, { session: undefined });
      ui.ok(`Stopped agent "${name}" (tmux session closed).`);
      if (record) {
        const changes = await this.worktrees(ws).status(record.worktreePath);
        ui.info(`Worktree preserved: ${displayPath(record.worktreePath)}`);
        if (changes?.dirty) ui.info(`${changes.files.length} uncommitted change(s) remain in the worktree.`);
        ui.line();
        ui.line('Restart:');
        ui.line(`  aw spawn ${name}            # new conversation`);
        ui.line(`  aw spawn ${name} --resume   # continue the previous conversation`);
      }
    });
  }

  /** Ask the agent CLI to exit gracefully (Ctrl-C twice), waiting briefly for it. */
  private async interrupt(sessionName: string, exitFile: string): Promise<void> {
    const { terminal } = this.deps;
    for (let attempt = 0; attempt < 2; attempt++) {
      await terminal.sendKeys(sessionName, ['C-c']).catch(() => undefined);
      for (let i = 0; i < 10; i++) {
        await sleep(150);
        if ((await readExitCode(exitFile)) !== null) return;
      }
    }
  }

  // ------------------------------------------------------------- attach

  async attach(name: string): Promise<number> {
    validateAgentName(name);
    const ws = await this.open();
    const record = await ws.state.getAgent(name);
    const sessionName = record?.session?.name ?? sessionNameFor(ws, name);
    if (!(await this.deps.terminal.hasSession(sessionName))) {
      throw new AwError(`Agent "${name}" is not running.`, {
        hint: `Start it with "aw spawn ${name}" (add --resume to continue its previous conversation).`,
      });
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AwError('"aw attach" needs an interactive terminal.', {
        exitCode: ExitCode.USAGE,
        hint: `From scripts, use: tmux attach -t "=${sessionName}"`,
      });
    }
    return this.deps.terminal.attach(sessionName);
  }

  // ------------------------------------------------------------- status

  async collectStatus(ws: Workspace): Promise<AgentStatus[]> {
    const state = await ws.state.load();
    const names = [...Object.keys(ws.config.agents), ...Object.keys(state.agents).filter((n) => !(n in ws.config.agents)).sort()];
    const manager = this.worktrees(ws);
    const rows: AgentStatus[] = [];
    for (const name of names) {
      const record = state.agents[name];
      const agent = resolveAgent(ws.config, name, record ? { provider: record.provider, branch: record.branch, base: record.base } : {});
      const sessionName = record?.session?.name ?? sessionNameFor(ws, name);
      const files = launchFilesFor(ws.state.agentDir(name));
      const worktreeExists = record ? await pathExists(record.worktreePath) : false;
      const session: AgentStatus['session'] = await getSessionState(this.deps.terminal, sessionName, files.exitFile).then((s) =>
        s === 'stopped' && !record ? 'not-spawned' : s,
      );
      let changes: AgentStatus['changes'] = null;
      if (record && worktreeExists) {
        const st = await manager.status(record.worktreePath);
        if (st) changes = { staged: st.staged, unstaged: st.unstaged, untracked: st.untracked, conflicted: st.conflicted };
      }
      let ahead: number | null = null;
      let behind: number | null = null;
      const base = await this.comparisonBase(ws, agent.base);
      if (base && (await this.deps.git.branchExists(this.repoCwd(ws), agent.branch))) {
        const counts = await this.deps.git.aheadBehind(this.repoCwd(ws), base, agent.branch);
        if (counts) ({ ahead, behind } = counts);
      }
      let task: TaskFile | null = null;
      try {
        task = await loadTask(ws.configRoot, agent.task);
      } catch {
        task = null;
      }
      rows.push({
        name,
        provider: agent.provider,
        branch: agent.branch,
        base: agent.base,
        configured: agent.configured,
        spawned: Boolean(record),
        worktreePath: record?.worktreePath ?? null,
        worktreeExists,
        session,
        sessionName,
        exitCode: session === 'exited' ? await readExitCode(files.exitFile) : null,
        changes,
        ahead,
        behind,
        task: {
          path: `.agents/${agent.task}`,
          title: task?.title ?? null,
          exists: task !== null,
          template: task?.isTemplate ?? false,
        },
        description: agent.description ?? null,
        dependsOn: agent.configured ? await this.dependencyStates(ws, agent) : [],
        pr: record?.pr ?? state.prs?.[name] ?? null,
        lastLaunchAt: record?.lastLaunch?.at ?? null,
      });
    }
    return rows;
  }

  // ------------------------------------------------------------ cleanup

  async cleanup(
    name: string,
    options: { yes?: boolean | undefined; deleteBranch?: boolean | undefined; discardIgnored?: boolean | undefined } = {},
  ): Promise<void> {
    validateAgentName(name);
    const { ui, terminal, git } = this.deps;
    const ws = await this.open();
    await this.withAgentLock(ws, name, 'cleanup', async () => {
      const manager = this.worktrees(ws);
      let record = await ws.state.getAgent(name);
      if (!record) {
        // Recover from an interrupted spawn: a marked worktree without state.
        const candidate = worktreePathFor(ws, name);
        const marker = await manager.readMarker(candidate);
        const entry = await manager.findByPath(candidate);
        if (marker?.agent === name && entry?.branch) {
          const now = new Date().toISOString();
          record = {
            name,
            provider: resolveAgent(ws.config, name).provider,
            branch: entry.branch,
            base: resolveAgent(ws.config, name).base,
            worktreePath: entry.path,
            createdAt: now,
            updatedAt: now,
          };
        } else {
          throw new AwError(`Agent "${name}" has no worktree to clean up.`, { exitCode: ExitCode.USAGE });
        }
      }

      const sessionName = record.session?.name ?? sessionNameFor(ws, name);
      const files = launchFilesFor(ws.state.agentDir(name));
      const sessionAlive = await terminal.hasSession(sessionName);
      const registered = await manager.findByPath(record.worktreePath);
      const exists = await pathExists(record.worktreePath);

      const removeOptions = {
        branch: record.branch,
        discardIgnored: options.discardIgnored,
        // Unchanged copies of local files (workspace.copyFiles) can go; edited ones are protected.
        disposable: (await pathExists(record.worktreePath))
          ? await unchangedCopies(record.worktreePath, path.join(ws.state.agentDir(name), 'copied-files.json'))
          : [],
      };
      if (registered && exists) {
        const status = await git.status(record.worktreePath);
        if (status.dirty) {
          throw new AwError(`Worktree for "${name}" has uncommitted changes; refusing to clean up.`, {
            exitCode: ExitCode.UNSAFE,
            details: status.files.slice(0, 15),
            hint: `Commit or stash the changes in ${displayPath(record.worktreePath)} first. Agent Workspace never deletes uncommitted work.`,
          });
        }
        await manager.assertRemovable(record.worktreePath, name, removeOptions);
      }

      // Report commits that exist only locally (they are kept on the branch).
      const cwd = this.repoCwd(ws);
      const base = await this.comparisonBase(ws, record.base);
      const remote = ws.config.project.remote;
      if (base && (await git.branchExists(cwd, record.branch))) {
        const counts = await git.aheadBehind(cwd, base, record.branch);
        const pushed = await git.remoteBranchExists(cwd, remote, record.branch);
        const unpushed = pushed ? await git.aheadBehind(cwd, `${remote}/${record.branch}`, record.branch) : null;
        if (counts && counts.ahead > 0 && (!pushed || (unpushed && unpushed.ahead > 0))) {
          ui.warn(
            `${record.branch} has ${counts.ahead} commit(s) not in ${base}${pushed ? ` and ${unpushed?.ahead} not pushed` : ' and is not pushed'}. They stay on the local branch.`,
          );
        }
      }

      const what = [
        sessionAlive ? `stop tmux session ${sessionName}` : null,
        registered ? `remove worktree ${displayPath(record.worktreePath)}` : null,
        options.deleteBranch ? `delete branch ${record.branch} (only if fully merged)` : `keep branch ${record.branch}`,
      ].filter(Boolean);
      await confirmOrAbort(this.deps.prompter, `Clean up agent "${name}": ${what.join(', ')}?`, { assumeYes: options.yes });

      if (sessionAlive) {
        if ((await getSessionState(terminal, sessionName, files.exitFile)) === 'running') {
          await this.interrupt(sessionName, files.exitFile);
        }
        await terminal.killSession(sessionName);
        ui.ok('tmux session stopped');
      }
      if (registered && exists) {
        await manager.remove(record.worktreePath, name, removeOptions);
        ui.ok(`Worktree removed (${displayPath(record.worktreePath)})`);
      } else if (registered && !exists) {
        ui.warn('Worktree directory is already gone; run "aw repair" to prune Git\'s stale worktree metadata.');
      }
      if (options.deleteBranch) {
        const result = await git.deleteBranchSafe(cwd, record.branch);
        if (result.exitCode === 0) ui.ok(`Branch ${record.branch} deleted`);
        else {
          ui.warn(
            `Branch ${record.branch} was kept: ${result.stderr.trim().split('\n')[0] ?? 'not fully merged'}. Delete it manually only if you are sure.`,
          );
        }
      } else {
        ui.info(`Branch ${record.branch} kept.`);
      }
      await ws.state.removeAgent(name);
      if (ws.config.agents[name]) {
        ui.info(`"${name}" is still configured in .agents/workspace.yaml; "aw spawn ${name}" recreates its worktree.`);
      }
    });
  }
}

/** Flags that disable an agent CLI's sandbox or approval prompts. */
const DANGEROUS_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--yolo',
  'danger-full-access',
  'bypassPermissions',
];

/**
 * workspace.yaml is versioned, so a cloned repository can choose which
 * executable runs and which flags are passed. Surface the risky cases.
 */
export function configTrustWarnings(
  providerId: string,
  providerConfig: { command?: string | undefined; args?: string[] | undefined },
  agentArgs: string[],
): string[] {
  const warnings: string[] = [];
  if (providerConfig.command) {
    warnings.push(
      `workspace.yaml runs a custom executable for ${providerId}: "${providerConfig.command}". Only continue if you trust this repository's configuration.`,
    );
  }
  const risky = [...(providerConfig.args ?? []), ...agentArgs].filter((a) => DANGEROUS_FLAGS.some((f) => a.includes(f)));
  if (risky.length) {
    warnings.push(`workspace.yaml passes flags that disable the agent's sandbox/approvals: ${risky.join(' ')}.`);
  }
  return warnings;
}

function describeWorktree(wt: EnsureWorktreeResult, agent: ResolvedAgent): string {
  switch (wt.source) {
    case 'existing-worktree':
      return wt.adopted ? 'Worktree recovered (adopted after an interrupted spawn)' : 'Worktree reused';
    case 'local-branch':
      return `Worktree created (existing branch ${agent.branch})`;
    case 'remote-branch':
      return `Worktree created (tracking ${wt.createdFrom})`;
    case 'new-branch':
      return `Worktree created (new branch ${agent.branch} from ${wt.createdFrom})`;
  }
}

export function sessionLabel(state: AgentStatus['session']): string {
  switch (state) {
    case 'running':
      return colors.green('● running');
    case 'exited':
      return colors.yellow('◐ exited');
    case 'stopped':
      return colors.dim('○ stopped');
    case 'not-spawned':
      return colors.dim('· not spawned');
  }
}
