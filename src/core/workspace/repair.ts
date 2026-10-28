import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Deps } from '../deps.js';
import type { AgentService } from '../agents/service.js';
import { WorktreeManager } from '../worktrees/manager.js';
import { resolveAgent } from '../config/loader.js';
import { WORKTREE_MARKER_FILE } from '../state/runtime-state.js';
import { sessionPrefix, dashboardSessionName } from './workspace.js';
import { removeIfStale, tryWithLock } from '../../infrastructure/filesystem/lock.js';
import { displayPath, pathExists, readTextIfExists } from '../../infrastructure/filesystem/fs.js';

/**
 * `aw repair`: recover from interrupted operations.
 *
 *  - removes stale lock files (owner process no longer exists),
 *  - re-adopts aw-marked worktrees missing from runtime state,
 *  - forgets state entries whose worktree directory no longer exists
 *    (only when no session is running and nobody holds the agent lock;
 *    branches and commits are never touched),
 *  - clears session records whose tmux session is gone,
 *  - removes Git's administrative data only for *aw-marked* worktrees whose
 *    directory was deleted (after confirmation). Unmarked (user) worktrees
 *    are reported, never pruned — their directory may just be unmounted.
 */

export interface RepairAction {
  kind: 'lock' | 'adopt' | 'forget' | 'session' | 'prune' | 'unmanaged-prunable' | 'orphan-session' | 'skipped';
  message: string;
  applied: boolean;
}

interface AdminEntry {
  id: string;
  dir: string;
  worktreePath: string;
  marked: boolean;
  agent: string | null;
}

/** Read `<common-dir>/worktrees/*` directly, so entries can be judged even when their directory is gone. */
async function readWorktreeAdminEntries(commonDir: string): Promise<AdminEntry[]> {
  const root = path.join(commonDir, 'worktrees');
  const entries: AdminEntry[] = [];
  for (const id of await fsp.readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, id);
    const gitdir = (await readTextIfExists(path.join(dir, 'gitdir')))?.trim();
    if (!gitdir) continue;
    const markerText = await readTextIfExists(path.join(dir, WORKTREE_MARKER_FILE));
    let agent: string | null = null;
    try {
      agent = markerText ? ((JSON.parse(markerText) as { agent?: string }).agent ?? null) : null;
    } catch {
      agent = null;
    }
    entries.push({ id, dir, worktreePath: path.dirname(gitdir), marked: agent !== null, agent });
  }
  return entries;
}

export async function repairWorkspace(
  deps: Deps,
  service: AgentService,
  options: { yes?: boolean | undefined; dryRun?: boolean | undefined } = {},
): Promise<RepairAction[]> {
  const ws = await service.open();
  const actions: RepairAction[] = [];
  const dry = Boolean(options.dryRun);

  // 1. Stale locks
  const lockFiles = [path.join(ws.state.dir, 'state.lock')];
  const agentsDir = path.join(ws.state.dir, 'agents');
  for (const entry of await fsp.readdir(agentsDir).catch(() => [] as string[])) {
    lockFiles.push(path.join(agentsDir, entry, 'agent.lock'));
  }
  for (const file of lockFiles) {
    if (!(await pathExists(file))) continue;
    if (dry) continue;
    const { removed, info } = await removeIfStale(file);
    if (removed) {
      actions.push({ kind: 'lock', message: `Removed stale lock ${path.relative(ws.state.dir, file)} (pid ${info?.pid ?? '?'})`, applied: true });
    }
  }

  // 2. Reconcile worktrees and state
  const manager = new WorktreeManager(deps.git, service.repoCwd(ws));
  const worktrees = await manager.list();
  const state = await ws.state.load();
  for (const { entry, marker } of worktrees) {
    if (!marker || state.agents[marker.agent] || !entry.branch) continue;
    const agent = resolveAgent(ws.config, marker.agent);
    if (!dry) {
      const now = new Date().toISOString();
      await ws.state.upsertAgent({
        name: marker.agent,
        provider: agent.provider,
        branch: entry.branch,
        base: agent.base,
        worktreePath: entry.path,
        createdAt: marker.createdAt || now,
        updatedAt: now,
      });
    }
    actions.push({ kind: 'adopt', message: `Re-adopted worktree for "${marker.agent}" (${displayPath(entry.path)})`, applied: !dry });
  }
  for (const record of Object.values(state.agents)) {
    const sessionName = record.session?.name;
    const sessionAlive = sessionName ? await deps.terminal.hasSession(sessionName) : false;
    if (!(await pathExists(record.worktreePath))) {
      if (sessionAlive) {
        actions.push({ kind: 'skipped', message: `Kept "${record.name}": its worktree is missing but its tmux session is still running`, applied: false });
        continue;
      }
      if (dry) {
        actions.push({ kind: 'forget', message: `Forget "${record.name}" (worktree ${displayPath(record.worktreePath)} no longer exists)`, applied: false });
        continue;
      }
      const done = await tryWithLock(ws.state.agentLockFile(record.name), { purpose: 'repair', resource: `Agent "${record.name}"` }, async () => {
        await ws.state.removeAgent(record.name);
        return true;
      });
      actions.push(
        done
          ? {
              kind: 'forget',
              message: `Forgot "${record.name}": worktree ${displayPath(record.worktreePath)} no longer exists (branch ${record.branch} is untouched)`,
              applied: true,
            }
          : { kind: 'skipped', message: `Skipped "${record.name}": another aw command is managing it`, applied: false },
      );
      continue;
    }
    if (record.session && !sessionAlive) {
      if (!dry) await ws.state.patchAgent(record.name, { session: undefined });
      actions.push({ kind: 'session', message: `Cleared stale session record for "${record.name}"`, applied: !dry });
    }
  }

  // 3. Git metadata for deleted worktree directories: only aw-marked ones are cleaned.
  const admin = await readWorktreeAdminEntries(ws.repo.commonDir);
  const missing: AdminEntry[] = [];
  for (const entry of admin) if (!(await pathExists(entry.worktreePath))) missing.push(entry);
  const marked = missing.filter((e) => e.marked);
  for (const e of missing.filter((x) => !x.marked)) {
    actions.push({
      kind: 'unmanaged-prunable',
      message: `Worktree ${displayPath(e.worktreePath)} (not created by aw) is missing; left untouched. If it is gone for good, run "git worktree prune".`,
      applied: false,
    });
  }
  if (marked.length) {
    let apply = !dry;
    if (apply) {
      apply = await deps.prompter.confirm(
        `Remove Git's metadata for ${marked.length} deleted agent worktree(s) (${marked.map((e) => e.agent).join(', ')})? Branches and commits are kept.`,
        { assumeYes: options.yes },
      );
    }
    for (const e of marked) {
      if (apply) await fsp.rm(e.dir, { recursive: true, force: true });
      actions.push({ kind: 'prune', message: `Pruned metadata of deleted worktree ${displayPath(e.worktreePath)} (agent "${e.agent}")`, applied: apply });
    }
  }

  // 4. Orphan tmux sessions (reported only)
  const prefix = sessionPrefix(ws);
  const known = new Set(Object.values((await ws.state.load()).agents).map((a) => a.session?.name).filter(Boolean));
  for (const session of await deps.terminal.listSessions()) {
    if (!session.startsWith(prefix) || session === dashboardSessionName(ws) || known.has(session)) continue;
    actions.push({
      kind: 'orphan-session',
      message: `tmux session ${session} has no matching agent record. Inspect it with "tmux attach -t =${session}" or close it with "tmux kill-session -t =${session}".`,
      applied: false,
    });
  }
  return actions;
}
