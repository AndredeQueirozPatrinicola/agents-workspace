import path from 'node:path';
import { AwError, ExitCode } from '../errors.js';
import type { Deps } from '../deps.js';
import type { AgentService } from './service.js';
import type { Effort } from '../accounts/settings.js';
import { AccountService } from '../accounts/service.js';
import { detectUsageLimit } from '../accounts/state.js';
import { FeatureStore } from '../features/store.js';
import { sharedPaths } from '../files/shared.js';
import { validateAgentName } from '../config/loader.js';
import { promises as fsp } from 'node:fs';
import { pathExists, readTextIfExists, writeFileAtomic } from '../../infrastructure/filesystem/fs.js';

/**
 * Switching an agent to another account (ADR 0002 §7).
 *
 * Conversations cannot move between accounts (their history lives in each
 * account's configuration directory), so the agent is relaunched in the same
 * worktree and tmux session with the new account and a handoff summary built
 * from Git and the previous terminal. The work itself is in Git, so nothing
 * is lost. Always initiated by the human; never automatic.
 */

const TERMINAL_TAIL_LINES = 60;
const MAX_SECTION = 4000;

const clip = (text: string, max = MAX_SECTION) => (text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text);

export async function buildHandoff(deps: Deps, agents: AgentService, name: string): Promise<string> {
  const ws = await agents.open();
  const record = await ws.state.getAgent(name);
  if (!record || !(await pathExists(record.worktreePath))) {
    throw new AwError(`Agent "${name}" has no worktree to hand over.`, { exitCode: ExitCode.USAGE });
  }
  const wt = record.worktreePath;
  const base = (await agents.comparisonBase(ws, record.base)) ?? record.base;
  const out = async (args: string[]) => {
    const r = await deps.git.run(wt, args);
    return r.exitCode === 0 ? r.stdout.trim() : '';
  };
  const commits = await out(['log', '--oneline', '--no-decorate', `${base}..HEAD`]);
  const stat = await out(['diff', '--stat', `${base}...HEAD`]);
  const status = await out(['status', '--short']);
  let terminal = '';
  if (record.session && (await deps.terminal.hasSession(record.session.name))) {
    terminal = (await deps.terminal.capture(record.session.name, 400).catch(() => ''))
      .trimEnd()
      .split('\n')
      // Usage-limit messages of the old account are noise for the new session (and would be re-detected).
      .filter((line) => !detectUsageLimit(line))
      .slice(-TERMINAL_TAIL_LINES)
      .join('\n');
  }
  // Last status report the agent wrote, if any.
  const outbox = sharedPaths(ws.workspaceDir, name).outbox;
  const reports = (await fsp.readdir(outbox).catch(() => [] as string[])).filter((f) => /^status(\.\d+)?\.json$/.test(f)).sort();
  const lastReport = reports.length ? await readTextIfExists(path.join(outbox, reports[reports.length - 1] as string)) : null;

  const lines = [
    'HANDOFF: you are continuing a task that another session of this agent started (it ran with a different account, which ran out of capacity or was switched by the human).',
    'You do not have its conversation. Everything it did that matters is in this worktree and its Git history. Start by reviewing the state below and the code, then continue from where it stopped. Do not redo committed work; finish uncommitted work if it is sound.',
    '',
    `Commits on your branch since ${base}:`,
    commits ? clip(commits) : '(none yet)',
    '',
    'Files changed on the branch:',
    stat ? clip(stat) : '(none)',
    '',
    'Uncommitted changes in the worktree:',
    status ? clip(status) : '(none)',
  ];
  if (lastReport) lines.push('', 'Last status report written by the previous session:', clip(lastReport, 1500));
  if (terminal) lines.push('', `Last ${TERMINAL_TAIL_LINES} lines of the previous session's terminal:`, '-----', clip(terminal), '-----');
  return lines.join('\n');
}

export interface SwitchResult {
  agent: string;
  from: string | null;
  to: string;
  provider: string;
}

export async function switchAccount(
  deps: Deps,
  agents: AgentService,
  name: string,
  accountName: string,
  options: { effort?: Effort | undefined; yes?: boolean | undefined } = {},
): Promise<SwitchResult> {
  validateAgentName(name);
  const ws = await agents.open();
  const record = await ws.state.getAgent(name);
  if (!record) throw new AwError(`Agent "${name}" has not been started yet.`, { exitCode: ExitCode.USAGE, hint: 'Choose its account before starting it.' });
  const account = await new AccountService(deps).forLaunch(accountName, ws.config);
  const handoff = await buildHandoff(deps, agents, name);
  await writeFileAtomic(path.join(ws.state.agentDir(name), 'handoff.md'), `${handoff}\n`);

  // Keep a feature task's route in sync, so restarts and the plan view show the new account.
  const info = ws.featureAgents[name];
  if (info) {
    const store = new FeatureStore(ws.state.dir);
    await store.update(info.feature, (f) => {
      const task = f.tasks.find((t) => t.id === info.task);
      if (!task) return;
      task.route = {
        ...task.route,
        account: account.name,
        provider: account.provider,
        model: account.provider === task.route.provider ? task.route.model : null,
        effort: options.effort ?? task.route.effort,
        reason: `switched by you from ${task.route.account || 'default'} to ${account.name}`,
        warnings: [],
      };
      if (task.status === 'attention') {
        task.status = 'running';
        task.attention = null;
      }
    });
    store.event(info.feature, { kind: 'info', task: info.task, text: `Switched from ${record.account ?? 'default login'} to ${account.name} (handoff)` });
  }

  await agents.restart(name, {
    yes: options.yes ?? true,
    account: account.name,
    provider: account.provider,
    effort: options.effort,
    prompt: handoff,
  });
  return { agent: name, from: record.account ?? null, to: account.name, provider: account.provider };
}
