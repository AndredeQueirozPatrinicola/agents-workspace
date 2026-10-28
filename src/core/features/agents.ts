import type { AgentConfig } from '../config/schema.js';
import { FeatureStore, taskAgentName } from './store.js';

/**
 * Feature tasks are agents like any other (worktree, branch, tmux session,
 * cleanup), but they are defined by the feature's runtime record instead of
 * `.agents/workspace.yaml`. This keeps the committed configuration and the
 * user's working tree untouched. They are merged into the configuration in
 * memory when a workspace is opened.
 */

export interface FeatureAgentInfo {
  feature: string;
  featureTitle: string;
  task: string;
  /** Planned account and effort (until the agent's first launch records its own). */
  account: string;
  effort: string;
}

export async function loadFeatureAgents(stateDir: string, branchPrefix: string): Promise<{ agents: Record<string, AgentConfig>; info: Record<string, FeatureAgentInfo> }> {
  const store = new FeatureStore(stateDir);
  const agents: Record<string, AgentConfig> = {};
  const info: Record<string, FeatureAgentInfo> = {};
  for (const feature of await store.list().catch(() => [])) {
    if (!feature.plan || feature.status === 'planning' || feature.status === 'plan-failed' || feature.status === 'review') continue;
    for (const task of feature.tasks) {
      const planned = feature.plan.tasks.find((t) => t.id === task.id);
      if (!planned || task.status === 'skipped') continue;
      const entry: AgentConfig = {
        provider: task.route.provider,
        branch: taskBranch(feature.branch, task.id, branchPrefix),
        base: feature.branch,
        task: store.taskFile(feature.id, task.id),
        description: planned.title,
      };
      if (task.route.model) entry.model = task.route.model;
      if (planned.scope.length) entry.scope = planned.scope;
      const deps = planned.dependsOn
        .filter((d) => feature.tasks.some((t) => t.id === d && t.status !== 'skipped'))
        .map((d) => taskAgentName(feature.id, d));
      if (deps.length) entry.dependsOn = deps;
      agents[task.agent] = entry;
      info[task.agent] = { feature: feature.id, featureTitle: feature.title, task: task.id, account: task.route.account, effort: task.route.effort };
    }
  }
  return { agents, info };
}

/** `feature/x` and `feature/x/y` cannot coexist as Git refs, so tasks use `feature/x--y`. */
export function taskBranch(featureBranch: string, taskId: string, _prefix?: string): string {
  return `${featureBranch}--${taskId}`;
}
