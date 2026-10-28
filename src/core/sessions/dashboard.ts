import { AwError } from '../errors.js';
import type { Deps } from '../deps.js';
import type { AgentService } from '../agents/service.js';
import { dashboardSessionName, sessionNameFor } from '../workspace/workspace.js';

/**
 * `aw dashboard`: a tmux session showing every running agent in a tiled
 * grid (several windows when there are many agents) plus a live status
 * window. Panes are nested tmux clients attached to the agent sessions, so
 * typing in a pane talks to that agent, and closing the dashboard never
 * stops an agent.
 */

export interface DashboardOptions {
  perWindow?: number | undefined;
  status?: boolean | undefined;
  attach?: boolean | undefined;
  kill?: boolean | undefined;
}

export interface DashboardResult {
  session: string;
  agents: string[];
  attached: boolean;
  killed: boolean;
}

export async function openDashboard(deps: Deps, service: AgentService, options: DashboardOptions = {}): Promise<DashboardResult> {
  const ws = await service.open();
  const name = dashboardSessionName(ws);
  const { terminal } = deps;
  if (options.kill) {
    const existed = await terminal.hasSession(name);
    await terminal.killSession(name);
    return { session: name, agents: [], attached: false, killed: existed };
  }
  await terminal.assertUsable();

  const state = await ws.state.load();
  const names = [...new Set([...Object.keys(ws.config.agents), ...Object.keys(state.agents)])];
  const panes: Array<{ title: string; session: string }> = [];
  for (const agent of names) {
    const session = state.agents[agent]?.session?.name ?? sessionNameFor(ws, agent);
    if (await terminal.hasSession(session)) {
      const record = state.agents[agent];
      panes.push({ title: `${agent} (${record?.provider ?? '?'}, ${record?.branch ?? '?'})`, session });
    }
  }
  if (panes.length === 0) {
    throw new AwError('No agents are running.', { hint: 'Start one with "aw spawn <agent>", then open the dashboard.' });
  }

  const socket = deps.env.AW_TMUX_SOCKET;
  const statusCommand = options.status === false
    ? undefined
    : ['env', ...(socket ? [`AW_TMUX_SOCKET=${socket}`] : []), ...deps.selfCommand, 'status', '--watch', '3'];
  await terminal.createDashboard({
    name,
    cwd: ws.configRoot,
    panes,
    perWindow: options.perWindow ?? 4,
    ...(statusCommand ? { statusCommand } : {}),
  });

  let attached = false;
  if (options.attach !== false && process.stdin.isTTY && process.stdout.isTTY) {
    await terminal.attach(name);
    attached = true;
  }
  return { session: name, agents: panes.map((p) => p.title.split(' ')[0] as string), attached, killed: false };
}
