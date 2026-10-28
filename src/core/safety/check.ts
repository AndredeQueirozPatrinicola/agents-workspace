import type { Deps } from '../deps.js';
import { resolveAgent } from '../config/loader.js';
import { loadTask } from '../tasks/task.js';
import type { AgentService } from '../agents/service.js';
import { findScopeOverlaps, matchesAny } from './safety.js';

/**
 * `aw check`: a read-only parallel-development safety report.
 *
 * Uses `git merge-tree --write-tree` (Git >= 2.38) to simulate merges in
 * memory, so no working tree, index or ref is modified.
 */

export type IssueLevel = 'error' | 'warning' | 'info';

export interface CheckIssue {
  level: IssueLevel;
  category: 'branch' | 'scope' | 'overlap' | 'outside-scope' | 'behind' | 'conflict' | 'dependency';
  agents: string[];
  message: string;
  details: string[];
}

export interface CheckReport {
  issues: CheckIssue[];
  agentsChecked: string[];
  mergeSimulation: boolean;
}

export async function runSafetyCheck(deps: Deps, service: AgentService, options: { fetch?: boolean } = {}): Promise<CheckReport> {
  const { git } = deps;
  const ws = await service.open();
  const cwd = service.repoCwd(ws);
  const state = await ws.state.load();
  const remote = ws.config.project.remote;
  const issues: CheckIssue[] = [];
  const mergeSimulation = await git.supportsMergeTree();

  if (options.fetch) {
    const bases = [...new Set(Object.keys(ws.config.agents).map((n) => resolveAgent(ws.config, n).base))];
    await git.fetch(cwd, remote, bases.length ? bases : [ws.config.project.baseBranch]);
  }

  const names = [...new Set([...Object.keys(ws.config.agents), ...Object.keys(state.agents)])];
  const agents = names.map((name) => {
    const record = state.agents[name];
    return resolveAgent(ws.config, name, record ? { branch: record.branch, base: record.base, provider: record.provider } : {});
  });

  // 1. Shared branches
  const byBranch = new Map<string, string[]>();
  for (const a of agents) byBranch.set(a.branch, [...(byBranch.get(a.branch) ?? []), a.name]);
  for (const [branch, owners] of byBranch) {
    if (owners.length > 1) {
      issues.push({
        level: 'error',
        category: 'branch',
        agents: owners,
        message: `Agents ${owners.join(', ')} use the same branch "${branch}".`,
        details: ['Give each agent its own branch; Git checks out a branch in only one worktree.'],
      });
    }
  }

  // 2. Declared scope overlaps (config `scope` + task "Files" section)
  const scopes: Record<string, string[]> = {};
  for (const a of agents) {
    const task = await loadTask(ws.configRoot, a.task, ws.taskRoots).catch(() => null);
    const scope = [...new Set([...a.scope, ...(task && !task.isTemplate ? task.files : [])])];
    if (scope.length) scopes[a.name] = scope;
  }
  for (const overlap of findScopeOverlaps(scopes)) {
    issues.push({
      level: 'warning',
      category: 'scope',
      agents: [overlap.a, overlap.b],
      message: `Declared scopes of ${overlap.a} and ${overlap.b} overlap.`,
      details: overlap.patterns.map(([x, y]) => `${x}  <->  ${y}`),
    });
  }

  // 3. Per-agent branch checks
  const changed = new Map<string, string[]>();
  const checked: string[] = [];
  for (const a of agents) {
    if (!(await git.branchExists(cwd, a.branch))) continue;
    const base = await service.comparisonBase(ws, a.base);
    if (!base) continue;
    checked.push(a.name);
    const files = await git.changedFiles(cwd, base, a.branch);
    changed.set(a.name, files);
    const counts = await git.aheadBehind(cwd, base, a.branch);
    if (counts && counts.behind > 0) {
      issues.push({
        level: 'warning',
        category: 'behind',
        agents: [a.name],
        message: `${a.name} (${a.branch}) is ${counts.behind} commit(s) behind ${base}.`,
        details: [`Update the branch (e.g. "git -C <worktree> merge ${base}") and re-run tests before opening a PR.`],
      });
    }
    if (scopes[a.name] && files.length) {
      const outside = files.filter((f) => !matchesAny(f, scopes[a.name] ?? []));
      if (outside.length) {
        issues.push({
          level: 'warning',
          category: 'outside-scope',
          agents: [a.name],
          message: `${a.name} changed ${outside.length} file(s) outside its declared scope.`,
          details: outside.slice(0, 15),
        });
      }
    }
    if (mergeSimulation && counts && counts.ahead > 0 && counts.behind > 0) {
      const merge = await git.checkMerge(cwd, base, a.branch);
      if (merge && !merge.clean) {
        issues.push({
          level: 'error',
          category: 'conflict',
          agents: [a.name],
          message: `${a.name} (${a.branch}) conflicts with ${base}.`,
          details: merge.conflicts.slice(0, 15),
        });
      }
    }
  }

  // 4. Pairwise: files touched by several agents, and simulated merges between them
  const withChanges = [...changed.entries()].filter(([, f]) => f.length > 0);
  for (let i = 0; i < withChanges.length; i++) {
    for (let j = i + 1; j < withChanges.length; j++) {
      const [a, fa] = withChanges[i] as [string, string[]];
      const [b, fb] = withChanges[j] as [string, string[]];
      const setB = new Set(fb);
      const shared = fa.filter((f) => setB.has(f));
      if (!shared.length) continue;
      const branchA = agents.find((x) => x.name === a)?.branch as string;
      const branchB = agents.find((x) => x.name === b)?.branch as string;
      const merge = mergeSimulation ? await git.checkMerge(cwd, branchA, branchB) : null;
      if (merge && !merge.clean) {
        issues.push({
          level: 'error',
          category: 'conflict',
          agents: [a, b],
          message: `${a} and ${b} have conflicting changes (will conflict when both are merged).`,
          details: merge.conflicts.slice(0, 15),
        });
      } else {
        issues.push({
          level: 'warning',
          category: 'overlap',
          agents: [a, b],
          message: `${a} and ${b} both modified ${shared.length} file(s)${merge ? ' (merges cleanly today)' : ''}.`,
          details: shared.slice(0, 15),
        });
      }
    }
  }

  // 5. Dependencies
  for (const a of agents) {
    if (!a.configured) continue;
    for (const dep of await service.dependencyStates(ws, a)) {
      if (dep.state === 'merged') continue;
      issues.push({
        level: 'info',
        category: 'dependency',
        agents: [a.name, dep.name],
        message: `${a.name} depends on ${dep.name}, which is ${dep.state.replace('-', ' ')}.`,
        details: [],
      });
    }
  }

  return { issues, agentsChecked: checked, mergeSimulation };
}
