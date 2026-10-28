import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { Option } from 'commander';
import type { Deps } from '../core/deps.js';
import { AwError, ExitCode } from '../core/errors.js';
import { FeatureService, routingStats } from '../core/features/service.js';
import type { FeatureStore } from '../core/features/store.js';
import { featureLine, featureText, STATUS_LABEL } from '../core/features/format.js';
import { AccountService } from '../core/accounts/service.js';
import { type Effort, EFFORTS, SETTINGS_TEMPLATE, addAccountToSettings, settingsFile } from '../core/accounts/settings.js';
import { parseUntil } from '../core/accounts/state.js';
import { switchAccount } from '../core/agents/handoff.js';
import type { AgentService } from '../core/agents/service.js';
import { displayPath, pathExists, writeFileExclusive } from '../infrastructure/filesystem/fs.js';
import { confirmOrAbort } from '../infrastructure/terminal/prompt.js';

/**
 * CLI for features (`aw feature …`), accounts (`aw accounts …`) and
 * account switching (`aw switch`). Thin adapters over core services.
 */

interface Services {
  d: Deps;
  agents: AgentService;
}

const effortOption = () => new Option('--effort <level>', 'reasoning effort').choices([...EFFORTS]);

export async function resolveFeatureId(store: FeatureStore, ref: string): Promise<string> {
  const ids = await store.ids();
  if (ids.includes(ref)) return ref;
  const matches = ids.filter((id) => id.startsWith(ref));
  if (matches.length === 1) return matches[0] as string;
  throw new AwError(matches.length ? `"${ref}" matches several features: ${matches.join(', ')}.` : `Unknown feature "${ref}".`, {
    exitCode: ExitCode.USAGE,
    hint: 'List features with: aw feature list',
  });
}

async function readRequest(d: Deps, words: string[], file: string | undefined): Promise<string> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (file) return fsp.readFile(path.resolve(d.cwd, file), 'utf8');
  return words.join(' ');
}

export function registerFeatureCommands(program: Command, services: () => Services, context: { exitCode: number }): void {
  const features = () => {
    const { d, agents } = services();
    return { d, agents, fs: new FeatureService(d) };
  };
  const feature = program
    .command('feature')
    .alias('features')
    .description('describe a feature in natural language; a planner splits it, agents execute it, aw integrates it');

  feature
    .command('new [request...]')
    .description('create a feature from a natural-language request and plan it')
    .option('-f, --file <file>', 'read the request from a file ("-" for stdin)')
    .option('--title <title>', 'feature title (default: from the request / the plan)')
    .option('--planner <provider|account>', 'planner to use (default: routing.planner in your settings, else the project default provider)')
    .option('--background', 'plan in a tmux session and return immediately')
    .option('--no-plan', 'only create the feature (plan later with "aw feature plan")')
    .action(async (words: string[], opts: { file?: string; title?: string; planner?: string; background?: boolean; plan?: boolean }) => {
      const { d, fs } = features();
      const request = await readRequest(d, words ?? [], opts.file);
      const plannerOpt = opts.planner ? (d.providers.ids().includes(opts.planner) ? { provider: opts.planner } : { account: opts.planner }) : undefined;
      const f = await fs.create(request, { title: opts.title, planner: plannerOpt });
      d.ui.ok(`Feature "${f.id}" created (planner: ${f.planner.route.account}, effort ${f.planner.route.effort})`);
      if (opts.plan === false) {
        d.ui.line(`Plan it with: aw feature plan ${f.id}`);
        return;
      }
      if (opts.background) {
        const session = await fs.planInBackground(f.id);
        d.ui.ok(`Planning in the background (tmux session ${session}).`);
        d.ui.line(`Check progress: aw feature show ${f.id}   (or open the dashboard: aw)`);
        return;
      }
      d.ui.info('Planning… the planner reads the repository (read-only); this can take a few minutes.');
      const planned = await fs.plan(f.id);
      d.ui.line();
      d.ui.line(featureText(planned));
      d.ui.line();
      d.ui.line('Next:');
      d.ui.line(`  aw feature approve ${planned.id}                         # start the agents`);
      d.ui.line(`  aw feature plan ${planned.id} --feedback "..."          # re-plan with your comments`);
      d.ui.line(`  aw feature route ${planned.id} <task> --account <a> --effort <e>`);
    });

  feature
    .command('list', { isDefault: true })
    .description('list features of this project')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { d, fs } = features();
      await fs.reconcile();
      const { store } = await fs.open();
      const list = await store.list();
      if (opts.json) return d.ui.line(JSON.stringify(list, null, 2));
      if (!list.length) {
        d.ui.line('No features yet.');
        d.ui.hint('Create one: aw feature new "Add JWT login to the admin panel; see docs/auth.md"   (or press n in the dashboard)');
        return;
      }
      for (const f of list) d.ui.line(`${f.id.padEnd(15)} ${featureLine(f).padEnd(28)} ${f.title}`);
    });

  feature
    .command('show <feature>')
    .description('plan, routing decisions, task progress and recent events')
    .option('--json', 'output machine-readable JSON')
    .action(async (ref: string, opts: { json?: boolean }) => {
      const { d, fs } = features();
      await fs.reconcile();
      const { store } = await fs.open();
      const id = await resolveFeatureId(store, ref);
      const f = await store.require(id);
      if (opts.json) return d.ui.line(JSON.stringify({ ...f, events: await store.events(id) }, null, 2));
      d.ui.line(featureText(f, await store.events(id)));
    });

  feature
    .command('plan <feature>')
    .description('(re-)plan a feature, optionally with feedback on the previous plan')
    .option('--feedback <text>', 'what to change in the plan')
    .option('--background', 'plan in a tmux session and return immediately')
    .addOption(new Option('--foreground').hideHelp())
    .action(async (ref: string, opts: { feedback?: string; background?: boolean; foreground?: boolean }) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      const id = await resolveFeatureId(store, ref);
      if (opts.background) {
        const session = await fs.replan(id, opts.feedback ?? '', { background: true });
        d.ui.ok(`Planning in the background (tmux session ${String(session)}).`);
        return;
      }
      if (!opts.foreground) d.ui.info('Planning… the planner reads the repository (read-only); this can take a few minutes.');
      const result = await fs.replan(id, opts.feedback ?? '');
      if (typeof result !== 'string') {
        d.ui.line();
        d.ui.line(featureText(result));
        if (opts.foreground) d.ui.line('\nPlan ready. Review it in the dashboard (aw) or with: aw feature show ' + id);
      }
    });

  feature
    .command('route <feature> <task>')
    .description('change the account and/or effort of a task (during review, or before it starts)')
    .option('--account <name>', 'account to use (aw accounts lists them)')
    .addOption(effortOption())
    .action(async (ref: string, task: string, opts: { account?: string; effort?: Effort }) => {
      const { d, fs } = features();
      if (!opts.account && !opts.effort) throw new AwError('Pass --account and/or --effort.', { exitCode: ExitCode.USAGE });
      const { store } = await fs.open();
      const f = await fs.setRoute(await resolveFeatureId(store, ref), task, opts);
      const t = f.tasks.find((x) => x.id === task);
      d.ui.ok(`${task}: ${t?.route.account} (${t?.route.provider}), effort ${t?.route.effort}`);
    });

  feature
    .command('skip <feature> <task>')
    .description('leave a task out of the plan (during review)')
    .option('--undo', 'put it back')
    .action(async (ref: string, task: string, opts: { undo?: boolean }) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      await fs.skipTask(await resolveFeatureId(store, ref), task, !opts.undo);
      d.ui.ok(opts.undo ? `${task} is back in the plan.` : `${task} skipped.`);
    });

  feature
    .command('approve <feature>')
    .description('approve the plan: create the feature branch and start the agents (the conductor runs in tmux)')
    .action(async (ref: string) => {
      const { d, fs } = features();
      const { store, ws } = await fs.open();
      const f = await fs.approve(await resolveFeatureId(store, ref));
      d.ui.ok(`Approved "${f.title}". Branch ${f.branch}.`);
      d.ui.ok(`The conductor (tmux session ${fs.conductorSession(ws)}) starts tasks, validates and integrates them.`);
      d.ui.line('Follow it in the dashboard (aw → 3 Features) or with: aw feature show ' + f.id);
    });

  feature
    .command('watch')
    .description('run the conductor in the foreground (normally started automatically in tmux)')
    .option('--once', 'advance every running feature once and exit')
    .action(async (opts: { once?: boolean }) => {
      const { fs } = features();
      await fs.watch({ once: opts.once });
    });

  feature
    .command('answer <feature> <task> <text...>')
    .description("answer a blocked task's question (typed into its agent)")
    .action(async (ref: string, task: string, text: string[]) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      await fs.answer(await resolveFeatureId(store, ref), task, text.join(' '));
      d.ui.ok('Answer sent; the task is running again.');
    });

  feature
    .command('retry <feature> <task>')
    .description('put a task that needs attention back to work (restarts its agent if needed)')
    .action(async (ref: string, task: string) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      await fs.retry(await resolveFeatureId(store, ref), task);
      await fs.ensureConductor();
      d.ui.ok(`${task} is running again.`);
    });

  feature
    .command('integrate <feature> <task>')
    .description('merge a validated task into the feature branch (features.integrate: confirm)')
    .action(async (ref: string, task: string) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      const id = await resolveFeatureId(store, ref);
      await fs.integrateNow(id, task);
      await fs.advance(id);
      d.ui.ok(`${task}: ${(await store.require(id)).tasks.find((t) => t.id === task)?.status}`);
    });

  feature
    .command('pr <feature>')
    .description('push the feature branch and open its pull request (asks before pushing; never merges)')
    .option('--draft', 'create as draft (default from workspace.yaml)')
    .option('--ready', 'create as ready for review')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--allow-sensitive', 'publish even if possible secrets are detected')
    .action(async (ref: string, opts: { draft?: boolean; ready?: boolean; yes?: boolean; allowSensitive?: boolean }) => {
      const { fs } = features();
      const { store } = await fs.open();
      await fs.pr(await resolveFeatureId(store, ref), { draft: opts.ready ? false : opts.draft, yes: opts.yes, allowSensitive: opts.allowSensitive });
    });

  feature
    .command('cancel <feature>')
    .description('stop a feature and its agents (worktrees and branches are kept)')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (ref: string, opts: { yes?: boolean }) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      const id = await resolveFeatureId(store, ref);
      await confirmOrAbort(d.prompter, `Cancel feature "${id}" and stop its agents? (worktrees, branches and commits are kept)`, { assumeYes: opts.yes });
      await fs.cancel(id);
      d.ui.ok(`Cancelled ${id}.`);
    });

  feature
    .command('cleanup <feature>')
    .description('remove the clean worktrees of a finished or cancelled feature (branches are kept)')
    .action(async (ref: string) => {
      const { d, fs } = features();
      const { store } = await fs.open();
      const removed = await fs.cleanup(await resolveFeatureId(store, ref));
      d.ui.ok(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove.');
    });

  // ------------------------------------------------------------ accounts
  const accounts = program.command('accounts').alias('account').description('provider accounts (isolated logins), availability marks and routing statistics');

  accounts
    .command('list', { isDefault: true })
    .description('list accounts and their availability')
    .option('--json', 'output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const { d } = services();
      const service = new AccountService(d);
      const list = await service.accounts();
      const marks = await service.marks.load();
      if (opts.json) return d.ui.line(JSON.stringify(list.map((a) => ({ ...a, mark: marks[a.name] ?? null })), null, 2));
      for (const a of list) {
        const mark = marks[a.name];
        const state = mark ? `limited${mark.until ? ` until ${new Date(mark.until).toLocaleString()}` : ''}${mark.note ? ` (${mark.note})` : ''}` : 'available';
        const home = a.home ? displayPath(a.home) : 'default login';
        const missing = a.home && !(await pathExists(a.home)) ? '  [not logged in: aw accounts login ' + a.name + ']' : '';
        d.ui.line(`${a.name.padEnd(18)} ${a.provider.padEnd(7)} ${state.padEnd(24)} ${home}${a.tags.length ? `  tags: ${a.tags.join(',')}` : ''}${missing}`);
      }
      d.ui.line();
      d.ui.hint(`Settings: ${displayPath(settingsFile(d.dataDir))}  (aw accounts edit)`);
    });

  accounts
    .command('add <name>')
    .description('declare an account: a provider plus its configuration directory')
    .requiredOption('-p, --provider <provider>', 'codex or claude')
    .option('--home <dir>', 'configuration directory (CODEX_HOME / CLAUDE_CONFIG_DIR); default: the CLI\'s own login')
    .option('--tag <tag>', 'tag used by project policies (repeatable), e.g. work or personal', (v: string, p: string[] = []) => [...p, v])
    .option('--label <label>', 'display name')
    .action(async (name: string, opts: { provider: string; home?: string; tag?: string[]; label?: string }) => {
      const { d } = services();
      d.providers.get(opts.provider);
      await addAccountToSettings(d.dataDir, name, { provider: opts.provider, home: opts.home, label: opts.label, tags: opts.tag ?? [] });
      d.ui.ok(`Account "${name}" added to ${displayPath(settingsFile(d.dataDir))}`);
      if (opts.home) d.ui.line(`Log in once with: aw accounts login ${name}`);
    });

  accounts
    .command('login <name>')
    .description("run the provider's own login with the account's configuration directory")
    .action(async (name: string) => {
      const { d } = services();
      const account = await new AccountService(d).require(name);
      const provider = d.providers.get(account.provider);
      if (account.home) await fsp.mkdir(account.home, { recursive: true });
      if (!process.stdin.isTTY) throw new AwError('Logging in needs an interactive terminal.', { exitCode: ExitCode.USAGE });
      const env = { ...d.env, ...(account.home ? { [provider.accountEnvVar]: account.home } : {}) };
      if (!provider.loginArgs.length) d.ui.info(`${provider.displayName} starts now: log in when asked (or type /login), then /exit.`);
      const code = await d.runner.runInteractive(provider.defaultCommand, [...provider.loginArgs], { env });
      if (code !== 0) context.exitCode = ExitCode.ERROR;
    });

  accounts
    .command('edit')
    .description('open settings.yaml (accounts and routing rules) in $VISUAL / $EDITOR')
    .action(async () => {
      const { d } = services();
      const file = settingsFile(d.dataDir);
      await fsp.mkdir(d.dataDir, { recursive: true });
      if (await writeFileExclusive(file, SETTINGS_TEMPLATE)) d.ui.ok(`Created ${displayPath(file)}`);
      if (!process.stdin.isTTY) return d.ui.line(file);
      const [cmd, ...args] = (d.env.VISUAL || d.env.EDITOR || 'nano').split(/\s+/).filter(Boolean);
      await d.runner.runInteractive(cmd ?? 'nano', [...args, file]);
      await new AccountService(d).context(null).then(
        () => d.ui.ok('Settings are valid.'),
        (error: unknown) => {
          context.exitCode = ExitCode.USAGE;
          throw error;
        },
      );
    });

  accounts
    .command('limited <name>')
    .description('mark an account as out of credits (shown in plans and the dashboard; nothing switches automatically)')
    .option('--until <when>', 'when it is available again: 18:00, 2h, 30m or a date')
    .option('--note <text>', 'note')
    .action(async (name: string, opts: { until?: string; note?: string }) => {
      const { d } = services();
      const service = new AccountService(d);
      await service.require(name);
      await service.marks.markLimited(name, { until: parseUntil(opts.until), note: opts.note ?? '' });
      d.ui.ok(`${name} marked as limited${opts.until ? ` until ${parseUntil(opts.until)?.toLocaleString()}` : ''}.`);
    });

  accounts
    .command('available <name>')
    .description('clear the limited mark of an account')
    .action(async (name: string) => {
      const { d } = services();
      await new AccountService(d).marks.clear(name);
      d.ui.ok(`${name} is available.`);
    });

  accounts
    .command('stats')
    .description('first-pass validation rate by complexity, provider and effort (data for tuning routing rules)')
    .action(async () => {
      const { d, fs } = features();
      const { store } = await fs.open();
      const rows = routingStats(await store.list());
      if (!rows.length) return d.ui.line('No completed feature tasks yet.');
      for (const r of rows) d.ui.line(`${r.key.padEnd(50)} ${r.firstPass}/${r.tasks} passed validation the first time (${Math.round((100 * r.firstPass) / r.tasks)}%)`);
    });

  // -------------------------------------------------------------- switch
  program
    .command('switch <agent> <account>')
    .description('continue an agent on another account: relaunch in the same worktree with a handoff summary')
    .addOption(effortOption())
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (agent: string, account: string, opts: { effort?: Effort; yes?: boolean }) => {
      const { d, agents } = services();
      await confirmOrAbort(d.prompter, `Relaunch "${agent}" with account "${account}"? (its conversation does not carry over; a handoff summary from Git and its terminal does)`, {
        assumeYes: opts.yes,
        defaultYes: true,
      });
      const r = await switchAccount(d, agents, agent, account, { effort: opts.effort });
      d.ui.ok(`${r.agent} now runs on ${r.to} (${r.provider})${r.from ? `, was ${r.from}` : ''}. Attach: aw attach ${r.agent}`);
    });
}

export { STATUS_LABEL };
