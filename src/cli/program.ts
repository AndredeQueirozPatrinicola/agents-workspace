import path from 'node:path';
import { Command, Option, InvalidArgumentError } from 'commander';
import { type Deps, createDefaultDeps } from '../core/deps.js';
import { AgentService } from '../core/agents/service.js';
import { PrService } from '../core/github/pr-service.js';
import { runSafetyCheck } from '../core/safety/check.js';
import { initWorkspace } from '../core/workspace/init.js';
import { runDoctor } from '../core/workspace/doctor.js';
import { repairWorkspace } from '../core/workspace/repair.js';
import { openDashboard } from '../core/sessions/dashboard.js';
import { AwError, ExitCode } from '../core/errors.js';
import { type SharedPaths, addToInbox, ensureShared, listShared, sharedPaths, sharedRoot } from '../core/files/shared.js';
import { validateAgentName } from '../core/config/loader.js';
import { displayPath } from '../infrastructure/filesystem/fs.js';
import { logger } from '../infrastructure/logger.js';
import { packageVersion } from '../infrastructure/filesystem/package-root.js';
import { renderCheck, renderDoctor, renderFiles, renderPrStatus, renderProjects, renderStatus } from './render.js';

/**
 * Command-line interface. Each action is a thin adapter: parse options,
 * call a core service, render the result. Business logic lives in core/.
 */

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function list(value: string, previous: string[] = []): string[] {
  return [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ProgramContext {
  /** Exit code requested by a command that completed without throwing. */
  exitCode: number;
}

export function buildProgram(baseDeps: Partial<Deps> = {}, context: ProgramContext = { exitCode: 0 }): Command {
  const program = new Command();
  let deps: Deps | null = null;
  const getDeps = (): Deps => {
    if (!deps) {
      const opts = program.opts<{ directory?: string }>();
      deps = createDefaultDeps({ ...baseDeps, ...(opts.directory ? { cwd: path.resolve(opts.directory) } : {}) });
    }
    return deps;
  };
  const services = () => {
    const d = getDeps();
    const agents = new AgentService(d);
    return { d, agents, prs: new PrService(d, agents) };
  };

  // Must be configured before subcommands are added so they inherit it:
  // commands report errors by throwing instead of calling process.exit().
  program.exitOverride();

  program
    .name('aw')
    .description('Agent Workspace: run multiple AI coding agents in parallel Git worktrees with tmux sessions.')
    .version(packageVersion(), '-V, --version', 'print the version')
    .option('-C, --directory <dir>', 'run as if aw was started in <dir>')
    .option('--verbose', 'print executed commands and debug output (or set AW_DEBUG=1)')
    .showHelpAfterError('(run "aw --help" for usage)')
    .hook('preAction', () => {
      if (program.opts<{ verbose?: boolean }>().verbose) logger.setLevel('debug');
    })
    .addHelpText(
      'after',
      `
Typical workflow:
  aw init
  aw spawn backend --provider codex --task "Build the REST API"
  aw spawn auth --provider claude
  aw dashboard
  aw pr backend --draft

Exit codes: 0 ok, 1 error, 2 usage/config, 3 missing prerequisite, 4 safety check, 130 aborted.`,
    );

  // ------------------------------------------------------------------ ui
  const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const openTui = async () => {
    const { runTui } = await import('../tui/run.js'); // loaded lazily: keeps plain CLI commands fast
    context.exitCode = await runTui(getDeps());
  };
  // `aw` with no command: the dashboard in a terminal, help otherwise (scripts are unaffected).
  program.action(async () => {
    if (program.args.length) {
      throw new AwError(`Unknown command "${program.args[0]}".`, { exitCode: ExitCode.USAGE, hint: 'Run "aw --help" for the list of commands.' });
    }
    if (interactive() && !getDeps().env.AW_NO_TUI) await openTui();
    else program.outputHelp();
  });
  program
    .command('ui')
    .description('open the interactive dashboard (also what plain "aw" does in a terminal)')
    .action(async () => {
      if (!interactive()) {
        throw new AwError('"aw ui" needs an interactive terminal.', { exitCode: ExitCode.USAGE, hint: 'Use "aw status --json" in scripts.' });
      }
      await openTui();
    });

  // ----------------------------------------------------------- projects
  const projects = program
    .command('projects')
    .description('global registry of the repositories Agent Workspace knows on this machine');
  projects
    .command('list', { isDefault: true })
    .description('list registered projects')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { d } = services();
      const list = await d.projects.list();
      if (opts.json) {
        d.ui.line(JSON.stringify(list, null, 2));
        return;
      }
      if (!list.length) {
        d.ui.line('No projects registered yet.');
        d.ui.hint('Register one with: aw projects add <path>   (or run any aw command inside an initialized repository)');
        return;
      }
      d.ui.line(renderProjects(list));
    });
  projects
    .command('add [path]')
    .description('register a Git repository (referenced in place, never copied)')
    .action(async (target: string | undefined) => {
      const { d } = services();
      const { project, created } = await d.projects.register(path.resolve(d.cwd, target ?? '.'));
      d.ui.ok(`${created ? 'Registered' : 'Already registered'}: ${project.name} (${displayPath(project.path)})`);
    });
  projects
    .command('remove <project>')
    .description('forget a project (by id, name or path); the repository is not touched')
    .action(async (ref: string) => {
      const { d } = services();
      const project = await d.projects.get(ref);
      if (!project) throw new AwError(`No registered project matches "${ref}".`, { exitCode: ExitCode.USAGE, hint: 'List them with: aw projects' });
      await d.projects.remove(project.id);
      d.ui.ok(`Forgot ${project.name}. Nothing in ${displayPath(project.path)} was changed.`);
    });

  // ------------------------------------------------------------- doctor
  program
    .command('doctor')
    .description('check prerequisites (git, tmux, gh, agent CLIs) and the current repository')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { d } = services();
      const checks = await runDoctor(d);
      if (opts.json) d.ui.line(JSON.stringify(checks, null, 2));
      else d.ui.line(renderDoctor(checks));
      if (checks.some((c) => c.status === 'fail')) context.exitCode = ExitCode.PREREQUISITE;
    });

  // --------------------------------------------------------------- init
  program
    .command('init')
    .description('create .agents/workspace.yaml in the current repository')
    .option('--name <name>', 'project name (default: repository directory name)')
    .option('--base <branch>', 'base branch for agent branches (default: detected)')
    .option('--provider <id>', 'default provider: codex | claude (default: first installed)')
    .option('--remote <name>', 'Git remote used for pushes and PRs', 'origin')
    .action(async (opts: { name?: string; base?: string; provider?: string; remote?: string }) => {
      const { d } = services();
      const result = await initWorkspace(d, opts);
      await d.projects.register(result.configRoot).catch(() => undefined);
      d.ui.header('Agent Workspace');
      d.ui.kv('Project', result.projectName);
      d.ui.kv('Base', result.baseBranch);
      d.ui.kv('Provider', result.provider);
      d.ui.line();
      for (const file of result.created) d.ui.ok(`Created ${file}`);
      d.ui.line();
      if (!result.hasCommits) {
        d.ui.warn('This repository has no commits yet. Agent worktrees branch off a commit, so commit before spawning.');
      }
      d.ui.line('Next steps:');
      d.ui.line('  git add .agents && git commit -m "Add Agent Workspace configuration"');
      d.ui.line('  aw spawn <agent> --provider codex|claude --task "What this agent should do"');
    });

  // ---------------------------------------------------------------- add
  program
    .command('add <agent>')
    .description('add an agent to workspace.yaml and create its task file (without starting it)')
    .option('-p, --provider <id>', 'codex | claude')
    .option('-b, --branch <branch>', 'branch name (default: <branchPrefix><agent>)')
    .option('-m, --model <model>', 'model to use (provider-specific)')
    .option('-t, --task <text>', 'objective written into the new task file')
    .option('-d, --description <text>', 'one-line description')
    .option('--scope <globs>', 'comma-separated file globs this agent owns', list)
    .option('--depends-on <agents>', 'comma-separated agents this one depends on', list)
    .action(async (agent: string, opts: { provider?: string; branch?: string; model?: string; task?: string; description?: string; scope?: string[]; dependsOn?: string[] }) => {
      const { d, agents } = services();
      const { taskCreated } = await agents.add(agent, { ...opts, taskText: opts.task });
      d.ui.ok(`Added agent "${agent}" to .agents/workspace.yaml`);
      if (taskCreated) d.ui.ok(`Created .agents/tasks/${agent}.md${opts.task ? '' : ' (template: edit it before spawning)'}`);
      d.ui.line();
      d.ui.line(`Start it with: aw spawn ${agent}`);
    });

  // -------------------------------------------------------------- spawn
  program
    .command('spawn <agent>')
    .description('create the worktree and branch (if needed) and launch the agent in a tmux session')
    .argument('[providerArgs...]', 'extra arguments for the provider CLI (put them after "--")')
    .option('-p, --provider <id>', 'codex | claude (overrides workspace.yaml)')
    .option('-m, --model <model>', 'model to use (provider-specific)')
    .option('-b, --branch <branch>', 'branch name (new agents only, default: <branchPrefix><agent>)')
    .option('--base <ref>', 'base branch for a new branch (default: project.baseBranch)')
    .option('-t, --task <text>', 'objective for a new agent (written into its task file)')
    .option('--task-file <path>', 'task file relative to .agents/ (overrides workspace.yaml)')
    .option('--prompt <text>', 'additional instructions appended to the initial prompt')
    .option('--no-prompt', 'start the agent without an initial prompt')
    .option('-r, --resume', "continue the provider's previous conversation in this worktree")
    .option('-a, --attach', 'attach to the session after starting it')
    .option('-y, --yes', 'answer yes to confirmations (e.g. adopting an existing worktree)')
    .option('-f, --file <path>', 'input file or folder for the agent (copied to its inbox, listed in the prompt; repeatable)', collect)
    .action(
      async (
        agent: string,
        providerArgs: string[],
        opts: { provider?: string; model?: string; branch?: string; base?: string; task?: string; taskFile?: string; prompt?: string | boolean; resume?: boolean; attach?: boolean; yes?: boolean; file?: string[] },
      ) => {
        const { agents } = services();
        await agents.spawn(agent, {
          provider: opts.provider,
          model: opts.model,
          branch: opts.branch,
          base: opts.base,
          taskText: opts.task,
          task: opts.taskFile,
          prompt: typeof opts.prompt === 'string' ? opts.prompt : undefined,
          noPrompt: opts.prompt === false,
          resume: opts.resume,
          attach: opts.attach,
          yes: opts.yes,
          files: opts.file,
          args: providerArgs,
        });
      },
    );

  // ------------------------------------------------------------- attach
  program
    .command('attach <agent>')
    .description("attach this terminal to the agent's tmux session (detach with the tmux prefix + d)")
    .action(async (agent: string) => {
      const { agents } = services();
      context.exitCode = (await agents.attach(agent)) === 0 ? 0 : ExitCode.ERROR;
    });

  // ------------------------------------------------------------ restart
  program
    .command('restart <agent>')
    .description('relaunch an agent in its existing tmux session (dashboard panes stay connected); e.g. after a failed login or Ctrl-C')
    .option('-r, --resume', "continue the provider's previous conversation instead of starting over with the task")
    .option('--prompt <text>', 'additional instructions appended to the initial prompt')
    .option('--no-prompt', 'start the agent CLI without an initial prompt')
    .option('-y, --yes', 'do not ask before interrupting a running agent')
    .option('-f, --file <path>', 'input file or folder for the agent (repeatable)', collect)
    .action(async (agent: string, opts: { resume?: boolean; prompt?: string | boolean; yes?: boolean; file?: string[] }) => {
      await services().agents.restart(agent, {
        files: opts.file,
        resume: opts.resume,
        prompt: typeof opts.prompt === 'string' ? opts.prompt : undefined,
        noPrompt: opts.prompt === false,
        yes: opts.yes,
      });
    });

  // --------------------------------------------------------------- tell
  program
    .command('tell <agent> <message...>')
    .description('type a message into a running agent (as if you typed it in its pane) and press Enter')
    .action(async (agent: string, message: string[]) => {
      await services().agents.tell(agent, message.join(' '));
    });

  // --------------------------------------------------------------- sync
  program
    .command('sync <agent>')
    .description("merge the base branch into the agent's branch (git merge, never rebase); conflicts are left for you or the agent")
    .option('--ask-agent', 'on conflicts, ask the (running) agent to resolve them, test and commit')
    .option('--no-fetch', 'do not fetch the base branch from the remote first')
    .option('-y, --yes', 'do not ask before merging while the agent is running')
    .action(async (agent: string, opts: { askAgent?: boolean; fetch: boolean; yes?: boolean }) => {
      const result = await services().agents.sync(agent, opts);
      if (result.conflicts.length && !opts.askAgent) context.exitCode = ExitCode.UNSAFE;
    });

  // -------------------------------------------------------------- files
  const files = program
    .command('files')
    .description('shared files area outside the repo: inputs for agents (inbox) and their non-code outputs (outbox)');
  files
    .command('list', { isDefault: true })
    .description('list inbox and outbox files')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { d, agents } = services();
      const ws = await agents.open();
      await ensureShared(ws.workspaceDir);
      const listing = await listShared(ws.workspaceDir);
      if (opts.json) {
        d.ui.line(JSON.stringify(listing, null, 2));
        return;
      }
      d.ui.line(renderFiles(listing));
    });
  files
    .command('add <paths...>')
    .description('copy files or folders into the inbox (all agents, or one with --agent)')
    .option('-a, --agent <name>', 'put them in this agent\'s inbox')
    .option('--tell', 'tell the (running) agent that the files are available')
    .action(async (paths: string[], opts: { agent?: string; tell?: boolean }) => {
      const { d, agents } = services();
      const ws = await agents.open();
      if (opts.agent) validateAgentName(opts.agent);
      if (opts.tell && !opts.agent) throw new AwError('--tell needs --agent <name>.', { exitCode: ExitCode.USAGE });
      const shared = opts.agent ? await ensureShared(ws.workspaceDir, opts.agent) : null;
      if (!opts.agent) await ensureShared(ws.workspaceDir);
      const inbox = shared ? shared.agentInbox : sharedPaths(ws.workspaceDir, 'x').inbox;
      const added = await addToInbox(paths.map((p) => path.resolve(d.cwd, p)), inbox);
      for (const f of added) d.ui.ok(`Added ${displayPath(f)}`);
      if (opts.tell && opts.agent) {
        await agents.tell(opts.agent, `New input file(s) for you: ${added.join(', ')}. Read them and use them for your task.`);
      }
    });
  files
    .command('path')
    .description('print the shared files directory (e.g. explorer.exe "$(aw files path)" on WSL)')
    .option('-a, --agent <name>', "print this agent's inbox instead")
    .option('--outbox', 'with --agent: print its outbox')
    .action(async (opts: { agent?: string; outbox?: boolean }) => {
      const { d, agents } = services();
      const ws = await agents.open();
      if (!opts.agent) {
        await ensureShared(ws.workspaceDir);
        d.ui.line(sharedRoot(ws.workspaceDir));
        return;
      }
      validateAgentName(opts.agent);
      const p = (await ensureShared(ws.workspaceDir, opts.agent)) as SharedPaths;
      d.ui.line(opts.outbox ? p.outbox : p.agentInbox);
    });

  // --------------------------------------------------------------- edit
  program
    .command('edit <agent>')
    .description("open the agent's task file in $VISUAL / $EDITOR (creates it from the template if missing)")
    .action(async (agent: string) => {
      const { d, agents } = services();
      const { path: file, created } = await agents.taskFileFor(agent);
      if (created) d.ui.ok(`Created ${file} from the template`);
      const editor = d.env.VISUAL || d.env.EDITOR || 'nano';
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        d.ui.line(file);
        return;
      }
      const [cmd, ...args] = editor.split(/\s+/).filter(Boolean);
      const code = await d.runner.runInteractive(cmd ?? 'nano', [...args, file]);
      if (code !== 0) context.exitCode = ExitCode.ERROR;
      else d.ui.line(`Next: aw spawn ${agent}   (or "aw restart ${agent}" if it is already running)`);
    });

  // --------------------------------------------------------------- stop
  program
    .command('stop <agent>')
    .description("stop the agent's tmux session; worktree, branch and commits are kept")
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (agent: string, opts: { yes?: boolean }) => {
      await services().agents.stop(agent, opts);
    });

  // ------------------------------------------------------------- status
  program
    .command('status')
    .description('show agents, providers, branches, worktrees, tasks, sessions and PRs')
    .option('--json', 'output machine-readable JSON')
    .addOption(new Option('-w, --watch [seconds]', 'refresh continuously').argParser(positiveInt))
    .action(async (opts: { json?: boolean; watch?: number | boolean }) => {
      const { d, agents } = services();
      const render = async () => {
        const ws = await agents.open();
        const rows = await agents.collectStatus(ws);
        if (opts.json) {
          return JSON.stringify(
            { project: ws.projectName, base: ws.config.project.baseBranch, workspaceDir: ws.workspaceDir, agents: rows },
            null,
            2,
          );
        }
        return renderStatus(
          { project: ws.projectName, base: ws.config.project.baseBranch, workspaceDir: ws.workspaceDir, warnings: ws.loaded.warnings },
          rows,
        );
      };
      if (!opts.watch) {
        d.ui.line(await render());
        return;
      }
      const interval = (typeof opts.watch === 'number' ? opts.watch : 3) * 1000;
      for (;;) {
        let text: string;
        try {
          text = await render();
        } catch (error) {
          text = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
        process.stdout.write('\u001b[2J\u001b[H');
        d.ui.line(text);
        d.ui.line(`\n(refreshing every ${interval / 1000}s, ${new Date().toLocaleTimeString()} · Ctrl-C to quit)`);
        await sleep(interval);
      }
    });

  // ---------------------------------------------------------- dashboard
  program
    .command('dashboard')
    .description('open a tmux grid of all running agents (closing it never stops agents)')
    .option('--per-window <n>', 'agent panes per tmux window', positiveInt, 4)
    .option('--no-status', 'do not add the live status window')
    .option('--no-shell', 'do not add the shell window (a terminal in the main repository)')
    .option('--no-attach', 'create the dashboard without attaching')
    .option('--kill', 'close the dashboard session (agents keep running)')
    .action(async (opts: { perWindow: number; status: boolean; shell: boolean; attach: boolean; kill?: boolean }) => {
      const { d, agents } = services();
      const result = await openDashboard(d, agents, opts);
      if (result.killed) d.ui.ok('Dashboard closed. Agents are still running.');
      else if (opts.kill) d.ui.info('No dashboard is open.');
      else if (!result.attached) {
        d.ui.ok(`Dashboard ready with ${result.agents.length} agent(s): ${result.agents.join(', ')}`);
        d.ui.line();
        d.ui.line('Open it with:');
        d.ui.line(`  tmux attach -t "=${result.session}"`);
      }
    });

  // ----------------------------------------------------------------- pr
  program
    .command('pr <agent|status>')
    .description('push the agent branch and open a pull request; "aw pr status" lists PRs and checks')
    .option('--draft', 'create a draft PR (default: defaults.createDraftPR)')
    .option('--no-draft', 'create a ready-for-review PR')
    .option('--title <title>', 'PR title (default: task title)')
    .option('--body-file <file>', 'PR body file (default: generated from the task and commits)')
    .option('-y, --yes', 'push without asking for confirmation')
    .option('--allow-sensitive', 'publish even if possible secrets or local-only files are detected')
    .option('--json', 'JSON output (for "aw pr status")')
    .action(async (target: string, opts: { draft?: boolean; title?: string; bodyFile?: string; yes?: boolean; allowSensitive?: boolean; json?: boolean }) => {
      const { d, prs } = services();
      if (target === 'status') {
        const rows = await prs.status();
        d.ui.line(opts.json ? JSON.stringify(rows, null, 2) : renderPrStatus(rows));
        return;
      }
      await prs.create(target, opts);
    });

  // ------------------------------------------------------------ cleanup
  program
    .command('cleanup <agent>')
    .description("remove a finished agent's worktree (refuses if there are uncommitted changes)")
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--delete-branch', 'also delete the branch if it is fully merged (git branch -d)')
    .option('--discard-ignored', 'allow deleting git-ignored files in the worktree (e.g. a local .env); build/dependency dirs are always allowed')
    .action(async (agent: string, opts: { yes?: boolean; deleteBranch?: boolean; discardIgnored?: boolean }) => {
      const { d, agents } = services();
      await agents.cleanup(agent, opts);
      d.ui.line();
      d.ui.line(`Cleaned up "${agent}".`);
    });

  // -------------------------------------------------------------- check
  program
    .command('check')
    .description('report overlapping scopes, shared files, stale branches and merge conflicts (read-only)')
    .option('--fetch', 'fetch the base branch from the remote first')
    .option('--json', 'output machine-readable JSON')
    .option('--strict', 'exit with code 4 when errors (conflicts, shared branches) are found')
    .action(async (opts: { fetch?: boolean; json?: boolean; strict?: boolean }) => {
      const { d, agents } = services();
      const report = await runSafetyCheck(d, agents, opts);
      d.ui.line(opts.json ? JSON.stringify(report, null, 2) : renderCheck(report));
      if (opts.strict && report.issues.some((i) => i.level === 'error')) context.exitCode = ExitCode.UNSAFE;
    });

  // ------------------------------------------------------------- repair
  program
    .command('repair')
    .description('recover from interrupted operations (stale locks, orphaned state, pruned worktrees)')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--dry-run', 'only report what would be done')
    .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
      const { d, agents } = services();
      const actions = await repairWorkspace(d, agents, opts);
      if (actions.length === 0) {
        d.ui.ok('Nothing to repair.');
        return;
      }
      for (const a of actions) {
        if (a.kind === 'orphan-session' || a.kind === 'unmanaged-prunable' || a.kind === 'skipped') d.ui.warn(a.message);
        else if (a.applied) d.ui.ok(a.message);
        else d.ui.info(`${opts.dryRun ? 'Would: ' : 'Skipped: '}${a.message}`);
      }
    });

  // Only the root command accepts stray words (to report "Unknown command" itself);
  // set last so subcommands keep commander's strict argument checking.
  program.allowExcessArguments(true);
  return program;
}

export function formatError(error: AwError): string[] {
  const lines = [error.message];
  for (const d of error.details) lines.push(`  ${d}`);
  if (error.hint) lines.push(`Hint: ${error.hint}`);
  return lines;
}

