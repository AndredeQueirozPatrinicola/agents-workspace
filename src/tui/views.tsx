import React from 'react';
import { Box, Text } from 'ink';
import type { AccountView, ActivityEntry, ProviderInfo, SettingsInfo } from '../core/workspace/controller.js';
import type { Feature } from '../core/features/store.js';
import type { RoutingStats } from '../core/features/service.js';
import { type Attention, STATUS_LABEL, TASK_GLYPH, featureLine, progress, taskStatusText } from '../core/features/format.js';
import { planWaves } from '../core/features/plan.js';
import type { AgentView, ProjectSnapshot, ProjectSummary } from '../core/workspace/snapshot.js';
import { HELP_SECTIONS, VIEW_LABELS, VIEWS, type Overlay, type ViewId } from './state.js';
import {
  aheadBehindText,
  changesText,
  pad,
  prText,
  relativeTime,
  sessionColor,
  sessionText,
  shortPath,
  truncate,
  windowed,
} from './format.js';

/** Presentational components. They receive data and sizes; they never fetch. */

interface Sized {
  width: number;
  height: number;
}

export const SIDEBAR_WIDTH = 26;

export function Sidebar({
  view,
  focused,
  height,
  projects = [],
  projectId = null,
  features = [],
  openFeature = null,
}: {
  view: ViewId;
  focused: boolean;
  height: number;
  projects?: ProjectSummary[];
  projectId?: string | null;
  features?: Feature[];
  openFeature?: string | null;
}) {
  const inner = SIDEBAR_WIDTH - 4;
  const lines: Array<{ text: string; color?: string; bold?: boolean; inverse?: boolean; dim?: boolean }> = [];
  for (const [i, v] of VIEWS.entries()) {
    lines.push({ text: `${i + 1} ${VIEW_LABELS[v]}`, ...(v === view ? { color: 'cyan', bold: true, inverse: focused } : {}) });
  }
  // Project tree: projects, and under the selected one its features and their tasks.
  const budget = height - 2 - lines.length - 1;
  const tree: typeof lines = [];
  for (const p of projects) {
    const selected = p.project.id === projectId;
    const badge = p.state === 'ready' ? (p.attention ? ' !' : '') : p.state === 'not-initialized' ? ' ·' : ' ✗';
    tree.push({ text: truncate(`${selected ? '▾' : '▸'} ${p.project.name}${badge}`, inner), ...(selected ? { bold: true } : { dim: true }) });
    if (!selected) continue;
    const visible = features.filter((f) => f.status !== 'done' && f.status !== 'cancelled');
    for (const f of visible) {
      const pr = progress(f);
      const mark = pr.attention ? '!' : f.status === 'running' ? '●' : f.status === 'review' ? '◆' : f.status === 'ready' || f.status === 'pr-open' ? '✓' : f.status === 'plan-failed' ? '✗' : '…';
      const count = f.tasks.length && f.status === 'running' ? ` ${pr.done}/${pr.total}` : '';
      tree.push({ text: truncate(` ${mark} ${f.id}${count}`, inner), ...(pr.attention || f.status === 'review' ? { color: 'yellow' } : {}), ...(f.id === openFeature ? { inverse: true } : {}) });
      if (f.status === 'running' || f.id === openFeature) {
        for (const t of f.tasks.filter((x) => x.status !== 'skipped')) {
          tree.push({ text: truncate(`    ${TASK_GLYPH[t.status]} ${t.id}`, inner), ...(t.status === 'blocked' || t.status === 'attention' ? { color: 'yellow' } : { dim: true }) });
        }
      }
    }
    const manual = p.agents;
    if (manual && !visible.length) tree.push({ text: truncate(`   ${manual} agent(s)`, inner), dim: true });
  }
  if (tree.length) {
    lines.push({ text: ' ' });
    lines.push(...tree.slice(0, Math.max(0, budget)));
    if (tree.length > budget && budget > 0) lines.push({ text: '  …', dim: true });
  }
  return (
    <Box flexDirection="column" width={SIDEBAR_WIDTH} flexShrink={0} height={height} borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} overflow="hidden">
      {lines.map((l, i) => (
        <Text key={i} color={l.color} bold={l.bold} inverse={l.inverse} dimColor={l.dim} wrap="truncate">
          {l.text}
        </Text>
      ))}
    </Box>
  );
}

export function TabBar({ view, width }: { view: ViewId; width: number }) {
  const text = VIEWS.map((v, i) => (v === view ? `[${i + 1} ${VIEW_LABELS[v]}]` : `${i + 1} ${VIEW_LABELS[v]}`)).join(' ');
  return <Text wrap="truncate">{truncate(text, width)}</Text>;
}

function Empty({ title, lines }: { title: string; lines: string[] }) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {lines.map((l, i) => (
        <Text key={i} color="gray" wrap="wrap">
          {l}
        </Text>
      ))}
    </Box>
  );
}

function ProjectProblem({ snapshot }: { snapshot: ProjectSnapshot }) {
  const color = snapshot.state === 'not-initialized' ? 'yellow' : 'red';
  return (
    <Box flexDirection="column">
      <Text bold>{snapshot.project.name}</Text>
      <Text color="gray">{shortPath(snapshot.project.path)}</Text>
      <Text> </Text>
      <Text color={color}>{snapshot.message}</Text>
      {snapshot.details.slice(0, 6).map((d, i) => (
        <Text key={i} color={color}>{`  ${d}`}</Text>
      ))}
      {snapshot.hint ? <Text color="gray">{snapshot.hint}</Text> : null}
    </Box>
  );
}

export function NoProject() {
  return (
    <Empty
      title="No project selected"
      lines={[
        'Agent Workspace manages Git repositories in place (nothing is copied).',
        'Press 2 for Projects, then + to register a repository, or p to switch projects.',
        'Tip: running aw inside an initialized repository selects it automatically.',
      ]}
    />
  );
}

export function AgentTable({ agents, cursor, width, height, selectable }: { agents: AgentView[]; cursor: number; width: number; height: number; selectable: boolean }) {
  if (!agents.length) {
    return (
      <Empty
        title="No agents yet"
        lines={['Press + to create one (name, provider, task); it starts right away in its own worktree and branch.', 'Or from a shell (o):  aw spawn <name> --provider codex|claude --task "..."']}
      />
    );
  }
  const cols = { name: 18, group: 14, provider: 13, state: 15, branch: Math.max(12, Math.min(28, width - 105)), ab: 9, changes: 14, pr: 10 };
  const header = `${pad('AGENT', cols.name)} ${pad('FEATURE', cols.group)} ${pad('ACCOUNT', cols.provider)} ${pad('STATE', cols.state)} ${pad('BRANCH', cols.branch)} ${pad('VS BASE', cols.ab)} ${pad('CHANGES', cols.changes)} ${pad('PR', cols.pr)} ACTIVITY`;
  const { start, items } = windowed(agents, cursor, Math.max(1, height - 1));
  return (
    <Box flexDirection="column">
      <Text color="gray" wrap="truncate">
        {truncate(header, width)}
      </Text>
      {items.map((a, i) => {
        const selected = selectable && start + i === cursor;
        return (
          <Box key={a.name}>
            <Text inverse={selected} wrap="truncate">
              {truncate(
                `${pad(a.name, cols.name)} ${pad(a.feature ? a.feature.id : 'manual', cols.group)} ${pad(a.profile === 'default' ? a.provider : a.profile, cols.provider)} ${pad(sessionText(a), cols.state)} ${pad(a.branch, cols.branch)} ${pad(aheadBehindText(a.ahead, a.behind), cols.ab)} ${pad(changesText(a.changes), cols.changes)} ${pad(prText(a.pr), cols.pr)} ${relativeTime(a.lastActivity)}`,
                width,
              )}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function AgentDetails({ agent, width }: { agent: AgentView; width: number }) {
  const rows: Array<[string, string, string?]> = [
    ['Agent', agent.name],
    ['State', sessionText(agent), sessionColor(agent.session)],
    ['Provider', agent.provider],
    ['Account', agent.profile === 'default' ? "default (the CLI's own login) · c switches" : `${agent.profile} · c switches`],
    ['Feature', agent.feature ? `${agent.feature.title} (${agent.feature.id}/${agent.feature.task})` : 'manual agent'],
    ['Model', agent.model ?? 'provider default'],
    ['Effort', agent.effort ?? 'provider default'],
    ['Task', agent.task.title ?? agent.description ?? (agent.task.exists ? '(untitled)' : '(no task file)')],
    ['Task file', agent.task.path + (agent.task.template ? '  [template]' : '')],
    ['Branch', `${agent.branch}  (base ${agent.base}, ${aheadBehindText(agent.ahead, agent.behind)})`],
    ['Worktree', agent.worktreePath ? shortPath(agent.worktreePath) + (agent.worktreeExists ? '' : '  (missing)') : 'not created'],
    ['Changes', changesText(agent.changes)],
    ['Session', agent.sessionName],
    ['Last activity', relativeTime(agent.lastActivity)],
    ['Exit status', agent.exitCode === null ? '-' : String(agent.exitCode)],
    ['Pull request', agent.pr ? `${prText(agent.pr)}  ${agent.pr.url}` : '-'],
    ['Depends on', agent.dependsOn.length ? agent.dependsOn.map((d) => `${d.name} (${d.state})`).join(', ') : '-'],
  ];
  return (
    <Box flexDirection="column">
      {rows.map(([k, v, color]) => (
        <Text key={k} wrap="truncate">
          <Text color="gray">{pad(k, 14)}</Text>
          <Text color={color}>{truncate(v, Math.max(10, width - 15))}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function AgentsView({ snapshot, cursor, width, height }: Sized & { snapshot: ProjectSnapshot | null; cursor: number }) {
  if (!snapshot) return <NoProject />;
  if (snapshot.state !== 'ready') return <ProjectProblem snapshot={snapshot} />;
  const selected = snapshot.agents[cursor];
  const tableHeight = Math.max(3, Math.min(snapshot.agents.length + 1, Math.floor(height / 2)));
  return (
    <Box flexDirection="column">
      <Text bold>{`Agents · ${snapshot.project.name}`}</Text>
      <AgentTable agents={snapshot.agents} cursor={cursor} width={width} height={tableHeight} selectable />
      {selected && height - tableHeight > 8 ? (
        <Box flexDirection="column" marginTop={1}>
          <AgentDetails agent={selected} width={width} />
        </Box>
      ) : null}
      {snapshot.orphanSessions.length ? (
        <Text color="yellow">{`Orphan tmux sessions (no agent record): ${snapshot.orphanSessions.join(', ')} · aw repair`}</Text>
      ) : null}
    </Box>
  );
}

export function OverviewView({ snapshot, cursor, width, height, projectCount, needs = [] }: Sized & { snapshot: ProjectSnapshot | null; cursor: number; projectCount: number; needs?: Attention[] }) {
  if (!snapshot) {
    return projectCount ? <NoProject /> : (
      <Empty
        title="Welcome to Agent Workspace"
        lines={[
          'No projects registered yet.',
          'Press 2 (Projects) and + to register a Git repository, or quit and run "aw init" inside one.',
          'Press ? for all keyboard shortcuts.',
        ]}
      />
    );
  }
  if (snapshot.state !== 'ready') return <ProjectProblem snapshot={snapshot} />;
  const agents = snapshot.agents;
  const count = (s: AgentView['session']) => agents.filter((a) => a.session === s).length;
  // Feature task agents fall behind their feature branch by design (other tasks get merged): not a problem.
  const behind = (a: AgentView) => (a.feature ? 0 : (a.behind ?? 0));
  const attention = agents.filter((a) => a.session === 'exited' || (a.changes?.conflicted ?? 0) > 0 || behind(a) > 0 || (a.spawned && !a.worktreeExists));
  const c = snapshot.config;
  // Line budget: sections shrink (and the branch list disappears) on small terminals.
  let budget = height - 3 - snapshot.warnings.length;
  const needRows = Math.min(needs.length, height < 24 ? 2 : 4);
  const attentionRows = Math.min(attention.length, height < 24 ? 2 : 5);
  budget -= 2 + Math.max(1, attentionRows + needRows + (needs.length > needRows ? 1 : 0));
  const agentRows = Math.max(1, Math.min(agents.length, Math.max(1, budget - (height < 24 ? 3 : 8))));
  budget -= 3 + agentRows;
  const branches = snapshot.branches.filter((b) => b.agent || b.pr || b.current);
  const branchRows = Math.max(0, Math.min(branches.length, budget - 3));
  return (
    <Box flexDirection="column">
      <Text bold>{snapshot.project.name}</Text>
      <Text color="gray" wrap="truncate">
        {truncate(`${shortPath(snapshot.project.path)} · base ${c?.baseBranch} · remote ${c?.remote} · worktrees ${shortPath(c?.workspaceDir)}`, width)}
      </Text>
      <Text wrap="truncate">
        <Text>{`${agents.length} agent(s): `}</Text>
        <Text color="green">{`${count('running')} running`}</Text>
        <Text>{' · '}</Text>
        <Text color="yellow">{`${count('exited')} exited`}</Text>
        <Text>{` · ${count('stopped')} stopped · ${count('not-spawned')} not started`}</Text>
      </Text>
      {snapshot.warnings.map((w, i) => (
        <Text key={i} color="yellow" wrap="truncate">{`! ${w}`}</Text>
      ))}
      <Text> </Text>
      <Text bold>Needs you</Text>
      <NeedsYou items={needs} width={width} max={needRows} />
      {attention.length === 0 && needs.length === 0 ? <Text color="gray">Nothing right now. Press n to describe a new feature.</Text> : null}
      {attention.slice(0, attentionRows).map((a) => (
        <Text key={a.name} color="yellow" wrap="truncate">
          {truncate(
            `• ${a.name}: ${[
              a.session === 'exited' ? `agent exited${a.exitCode !== null ? ` (${a.exitCode})` : ''}, press r to restart` : null,
              (a.changes?.conflicted ?? 0) > 0 ? 'merge conflicts' : null,
              behind(a) > 0 ? `${a.behind} behind ${a.base}` : null,
              a.spawned && !a.worktreeExists ? 'worktree missing (aw repair)' : null,
            ]
              .filter(Boolean)
              .join(' · ')}`,
            width,
          )}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Agents</Text>
      <AgentTable agents={agents} cursor={cursor} width={width} height={agentRows + 1} selectable />
      {branchRows > 0 ? (
        <>
          <Text> </Text>
          <Text bold>Branches and pull requests</Text>
          {branches.slice(0, branchRows).map((b) => (
            <Text key={b.name} wrap="truncate">
              {truncate(
                `${b.current ? '*' : ' '} ${pad(b.name, 28)} ${pad(b.agent ? `agent ${b.agent}` : '', 16)} ${pad(aheadBehindText(b.ahead, b.behind), 9)} ${prText(b.pr)}${b.pr ? `  ${b.pr.url}` : ''}`,
                width,
              )}
            </Text>
          ))}
          {budget - branchRows > 3 ? <Text color="gray">PR status comes from the last "g" refresh or aw pr / aw pr status.</Text> : null}
        </>
      ) : null}
    </Box>
  );
}

export function ProjectsView({ projects, selectedId, cursor, width, height, loading }: Sized & { projects: ProjectSummary[]; selectedId: string | null; cursor: number; loading: boolean }) {
  if (!projects.length) {
    return (
      <Empty
        title={loading ? 'Loading projects…' : 'No projects registered'}
        lines={loading ? [] : ['Press + to register a Git repository by path (it is used in place, never copied).', 'Repositories also register themselves when you run any aw command inside an initialized repo.']}
      />
    );
  }
  const { start, items } = windowed(projects, cursor, Math.max(1, height - 3));
  const stateText = (s: ProjectSummary) =>
    s.state === 'ready' ? `${s.running}/${s.agents} running${s.attention ? `, ${s.attention} need attention` : ''}` : (s.message ?? s.state);
  return (
    <Box flexDirection="column">
      <Text bold>Projects</Text>
      <Text color="gray" wrap="truncate">
        {truncate(`  ${pad('NAME', 20)} ${pad('STATUS', 34)} PATH`, width)}
      </Text>
      {items.map((s, i) => {
        const index = start + i;
        const color = s.state === 'ready' ? undefined : s.state === 'not-initialized' ? 'yellow' : 'red';
        return (
          <Text key={s.project.id} inverse={index === cursor} color={color} wrap="truncate">
            {truncate(`${s.project.id === selectedId ? '●' : ' '} ${pad(s.project.name, 20)} ${pad(stateText(s), 34)} ${shortPath(s.project.path)}`, width)}
          </Text>
        );
      })}
      <Text color="gray">enter select · + register · - forget · I init · o shell</Text>
    </Box>
  );
}

export function FeaturesView({
  snapshot,
  features,
  cursor,
  openFeature,
  taskCursor,
  width,
  height,
}: Sized & { snapshot: ProjectSnapshot | null; features: Feature[]; cursor: number; openFeature: string | null; taskCursor: number }) {
  if (!snapshot) return <NoProject />;
  if (snapshot.state !== 'ready') return <ProjectProblem snapshot={snapshot} />;
  const open = openFeature ? features.find((f) => f.id === openFeature) : undefined;
  if (open) return <PlanView feature={open} cursor={taskCursor} width={width} height={height} />;
  if (!features.length) {
    return (
      <Empty
        title={`Features · ${snapshot.project.name}`}
        lines={[
          'Press n (anywhere) and describe what you want, the way you would to Claude or Codex: the goal, context, files to look at (paths), constraints.',
          'A planner reads the repository (read-only) and proposes tasks, each with an account, model effort and the reason. You review, adjust and approve with A.',
          'Agents then work in parallel on their own branches; the conductor validates each task and merges it into one feature branch. You are called only when a decision is needed.',
          'Small, one-off jobs: create a manual agent with + in Agents (a).',
        ]}
      />
    );
  }
  const { start, items } = windowed(features, cursor, Math.max(1, height - 3));
  return (
    <Box flexDirection="column">
      <Text bold>{`Features · ${snapshot.project.name}`}</Text>
      <Text color="gray" wrap="truncate">
        {truncate(`  ${pad('ID', 15)} ${pad('STATUS', 30)} TITLE`, width)}
      </Text>
      {items.map((f, i) => {
        const p = progress(f);
        const color = p.attention || f.status === 'review' ? 'yellow' : f.status === 'plan-failed' ? 'red' : f.status === 'ready' ? 'green' : f.status === 'cancelled' || f.status === 'done' ? 'gray' : undefined;
        return (
          <Text key={f.id} inverse={start + i === cursor} color={color} wrap="truncate">
            {truncate(`  ${pad(f.id, 15)} ${pad(featureLine(f), 30)} ${f.title}`, width)}
          </Text>
        );
      })}
      <Text color="gray">enter open plan · n new · v details · P pull request · X cancel · C clean up</Text>
    </Box>
  );
}

export function planKeysFor(f: Feature): string {
  switch (f.status) {
    case 'review':
      return 'A approve · f re-plan with feedback · c account · e effort · space skip · v details · esc back';
    case 'running':
      return 'w answer · r retry · i integrate · c switch account · t attach · l logs · d diff · X cancel · esc back';
    case 'ready':
    case 'pr-open':
      return 'P open/refresh PR · C clean up worktrees · t attach · d diff · v details · esc back';
    case 'plan-failed':
      return 'f re-plan (optionally with feedback) · v details (error) · X cancel · esc back';
    default:
      return 'v details · esc back';
  }
}

export function PlanView({ feature: f, cursor, width, height }: Sized & { feature: Feature; cursor: number }) {
  const head: Array<{ text: string; color?: string; bold?: boolean }> = [
    { text: f.title, bold: true },
    { text: `${STATUS_LABEL[f.status]} · ${f.branch} from ${f.base} · integration ${f.integrate}${f.pr ? ` · PR #${f.pr.number} ${f.pr.url}` : ''}`, color: 'gray' },
  ];
  if (f.status === 'planning') {
    head.push(
      { text: ' ' },
      { text: `The planner (${f.planner.route.account}, ${f.planner.route.provider}, effort ${f.planner.route.effort}) is reading the repository…`, color: 'cyan' },
      { text: 'This usually takes 1-5 minutes. You can leave this screen or quit aw; planning continues in tmux.', color: 'gray' },
    );
  }
  if (f.status === 'plan-failed') head.push({ text: ' ' }, { text: `Planning failed: ${f.planner.error ?? 'unknown error'}`, color: 'red' });
  if (!f.plan) {
    head.push({ text: ' ' }, { text: 'Request:', bold: true }, ...f.request.split('\n').slice(0, Math.max(1, height - 10)).map((l) => ({ text: `  ${l}` })));
    return (
      <Box flexDirection="column">
        {head.map((l, i) => (
          <Text key={i} color={l.color} bold={l.bold} wrap="truncate">
            {truncate(l.text, width)}
          </Text>
        ))}
        <Text color="gray">{planKeysFor(f)}</Text>
      </Box>
    );
  }
  head.push({ text: truncate(f.plan.summary.replace(/\s+/g, ' '), width * 2) });
  const waves = planWaves({ tasks: f.plan.tasks.filter((t) => f.tasks.find((s) => s.id === t.id)?.status !== 'skipped') });
  head.push({ text: `Waves: ${waves.map((w, i) => `${i + 1}) ${w.join(' + ')}`).join('   ')}`, color: 'gray' });
  for (const q of f.plan.questions.slice(0, 2)) head.push({ text: `? ${q}`, color: 'yellow' });
  for (const w of f.planWarnings.slice(0, 2)) head.push({ text: `! ${w}`, color: 'yellow' });

  const tasks = f.tasks;
  const selected = tasks[cursor];
  const planned = selected ? f.plan.tasks.find((t) => t.id === selected.id) : undefined;
  const detailLines: Array<{ text: string; color?: string }> = [];
  if (selected && planned) {
    detailLines.push({ text: `${planned.title}`, color: 'cyan' });
    detailLines.push({ text: `why ${selected.route.account || '(no account)'} · effort ${selected.route.effort}: ${selected.route.reason}` });
    detailLines.push({ text: `rating: complexity ${planned.complexity}, risk ${planned.risk} — ${planned.rationale}`, color: 'gray' });
    for (const w of selected.route.warnings) detailLines.push({ text: `! ${w}`, color: 'yellow' });
    detailLines.push({ text: `objective: ${planned.objective.replace(/\s+/g, ' ')}` });
    if (planned.scope.length) detailLines.push({ text: `scope: ${planned.scope.join(', ')}`, color: 'gray' });
    if (planned.validation.length) detailLines.push({ text: `validation: ${planned.validation.join(' && ')}`, color: 'gray' });
    if (planned.dependsOn.length) detailLines.push({ text: `after: ${planned.dependsOn.join(', ')}`, color: 'gray' });
    if (selected.attention) detailLines.push({ text: `>> ${selected.attention}`, color: 'yellow' });
    if (selected.report?.summary) detailLines.push({ text: `report: ${selected.report.summary.replace(/\s+/g, ' ')}` });
    if (selected.validation) detailLines.push({ text: `validation ${selected.validation.ok ? 'passed' : 'failed'}: ${selected.validation.output.split('\n').slice(0, 2).join(' | ')}`, color: selected.validation.ok ? 'green' : 'red' });
  }
  // The task table has priority over the details of the selected task.
  const tableRows = Math.max(1, Math.min(tasks.length, height - head.length - 5));
  const { start, items } = windowed(tasks, cursor, tableRows);
  const detailRoom = Math.max(0, height - head.length - tableRows - 4);
  detailLines.splice(detailRoom);
  const color = (st: Feature['tasks'][number]['status']) => (st === 'integrated' ? 'green' : st === 'blocked' || st === 'attention' ? 'yellow' : st === 'skipped' ? 'gray' : st === 'running' || st === 'validating' ? 'cyan' : undefined);
  return (
    <Box flexDirection="column">
      {head.map((l, i) => (
        <Text key={i} color={l.color} bold={l.bold} wrap="truncate">
          {truncate(l.text, width)}
        </Text>
      ))}
      <Text color="gray" wrap="truncate">
        {truncate(`  ${pad('TASK', 14)} ${pad('STATUS', 18)} ${pad('ACCOUNT', 16)} ${pad('EFFORT', 7)} ${pad('RATING', 10)} TITLE`, width)}
      </Text>
      {items.map((t, i) => {
        const p = f.plan?.tasks.find((x) => x.id === t.id);
        return (
          <Text key={t.id} inverse={start + i === cursor} color={color(t.status)} wrap="truncate">
            {truncate(
              `${TASK_GLYPH[t.status]} ${pad(t.id, 14)} ${pad(taskStatusText(t, f.status), 18)} ${pad(t.route.account || '-', 16)} ${pad(t.route.effort, 7)} ${pad(p ? `${p.complexity[0]}/${p.risk[0]}` : '', 10)} ${p?.title ?? ''}`,
              width,
            )}
          </Text>
        );
      })}
      <Box flexDirection="column" marginTop={detailLines.length ? 1 : 0}>
        {detailLines.map((l, i) => (
          <Text key={i} color={l.color} wrap="truncate">
            {truncate(l.text, width)}
          </Text>
        ))}
      </Box>
      <Text color="gray" wrap="truncate">
        {truncate(planKeysFor(f), width)}
      </Text>
    </Box>
  );
}

export function NeedsYou({ items, width, max }: { items: Attention[]; width: number; max: number }) {
  if (!items.length) return null;
  return (
    <Box flexDirection="column">
      {items.slice(0, max).map((a, i) => (
        <Text key={i} color={a.kind === 'ready' ? 'green' : a.kind === 'plan-failed' ? 'red' : 'yellow'} wrap="truncate">
          {truncate(`◆ ${a.text}`, width)}
        </Text>
      ))}
      {items.length > max ? <Text color="gray">{`… ${items.length - max} more in Features (3)`}</Text> : null}
    </Box>
  );
}

export function AccountsView({
  accounts,
  providers,
  stats,
  cursor,
  width,
  settingsPath,
}: {
  accounts: AccountView[] | null;
  providers: ProviderInfo[] | null;
  stats: RoutingStats[];
  cursor: number;
  width: number;
  settingsPath: string;
}) {
  const list = accounts ?? [];
  return (
    <Box flexDirection="column">
      <Text bold>Accounts</Text>
      <Text color="gray" wrap="truncate">
        {truncate(`  ${pad('ACCOUNT', 18)} ${pad('PROVIDER', 8)} ${pad('STATE', 26)} ${pad('PROJECT', 12)} LOGIN`, width)}
      </Text>
      {accounts === null ? <Text color="gray">Loading…</Text> : null}
      {list.map((a, i) => {
        const state = a.mark ? `limited${a.mark.until ? ` until ${new Date(a.mark.until).toLocaleTimeString()}` : ''}${a.mark.source === 'detected' ? ' (detected)' : ''}` : 'available';
        const color = !a.allowed ? 'gray' : a.mark ? 'yellow' : !a.loggedIn ? 'red' : undefined;
        return (
          <Text key={a.name} inverse={i === cursor} color={color} wrap="truncate">
            {truncate(
              `  ${pad(a.name, 18)} ${pad(a.provider, 8)} ${pad(state, 26)} ${pad(a.allowed ? 'allowed' : 'not allowed', 12)} ${a.home ? `${shortPath(a.home)}${a.loggedIn ? '' : ' (not logged in: L)'}` : 'default login'}${a.tags.length ? `  [${a.tags.join(',')}]` : ''}`,
              width,
            )}
          </Text>
        );
      })}
      <Text color="gray" wrap="truncate">
        {truncate(`m mark limited/available · L log in · E edit accounts and routing rules (${shortPath(settingsPath)})`, width)}
      </Text>
      <Text color="gray" wrap="wrap">
        Accounts are never switched automatically. When an agent hits a limit, press c on it (Agents, or the feature plan) to continue on another account with a handoff.
      </Text>
      <Text> </Text>
      <Text bold>Routing results (first-pass validation)</Text>
      {stats.length === 0 ? <Text color="gray">No finished feature tasks yet. As tasks complete, this shows which effort levels pass validation the first time, so you can tune the rules.</Text> : null}
      {stats.slice(0, 6).map((r) => (
        <Text key={r.key} wrap="truncate">
          {truncate(`  ${pad(r.key, 46)} ${r.firstPass}/${r.tasks} (${Math.round((100 * r.firstPass) / r.tasks)}%)`, width)}
        </Text>
      ))}
      <Text> </Text>
      <Text bold>Agent CLIs</Text>
      {providers === null ? <Text color="gray">Detecting provider CLIs…</Text> : null}
      {(providers ?? []).map((p) => (
        <Text key={p.id} wrap="truncate" color={p.installed ? undefined : 'yellow'}>
          {truncate(`  ${pad(p.name, 14)} ${pad(p.installed ? `installed ${p.version ?? ''}` : 'not installed', 22)} ${p.installed ? (p.missingFlags.length ? `missing flags: ${p.missingFlags.join(', ')}` : '') : p.installHint}`, width)}
        </Text>
      ))}
    </Box>
  );
}

export function ActivityView({ entries, cursor, width, height }: Sized & { entries: ActivityEntry[]; cursor: number }) {
  if (!entries.length) {
    return <Empty title="Activity" lines={['Actions you take here (start, stop, restart, register, …) and their results appear in this list.', 'Persistent event history arrives with the SQLite store in Milestone 2.']} />;
  }
  const { start, items } = windowed(entries, cursor, Math.max(1, height - 1));
  const color = (k: ActivityEntry['kind']) => (k === 'error' ? 'red' : k === 'warn' ? 'yellow' : k === 'success' ? 'green' : undefined);
  return (
    <Box flexDirection="column">
      <Text bold>Activity</Text>
      {items.map((e, i) => (
        <Text key={`${e.at}-${i}`} inverse={start + i === cursor} color={color(e.kind)} wrap="truncate">
          {truncate(`${new Date(e.at).toLocaleTimeString()} ${e.project ? `[${e.project}] ` : ''}${e.text}`, width)}
        </Text>
      ))}
    </Box>
  );
}

export function SettingsView({ settings, snapshot, refreshMs }: { settings: SettingsInfo; snapshot: ProjectSnapshot | null; refreshMs: number }) {
  const rows: Array<[string, string]> = [
    ['Version', settings.version],
    ['Data directory', shortPath(settings.dataDir)],
    ['Project registry', shortPath(settings.registryFile)],
    ['tmux server', settings.tmuxSocket ? `-L ${settings.tmuxSocket} (AW_TMUX_SOCKET)` : 'default'],
    ['Worktree root', settings.workspaceDirOverride ? `${settings.workspaceDirOverride} (AW_WORKSPACE_DIR)` : 'per project (workspace.directory)'],
    ['Auto refresh', `${Math.round(refreshMs / 1000)}s`],
    ['Project config', snapshot?.config ? `${shortPath(snapshot.project.path)}/${snapshot.config.configPath}` : '-'],
  ];
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      {rows.map(([k, v]) => (
        <Text key={k}>
          <Text color="gray">{pad(k, 18)}</Text>
          <Text>{v}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text color="gray">Settings are read-only in this version. Global preferences (routing, concurrency, retention) arrive with Milestone 2.</Text>
    </Box>
  );
}

export function OverlayView({ overlay, projects, width, height }: { overlay: Overlay; projects: ProjectSummary[]; width: number; height: number }) {
  const boxWidth = Math.max(30, Math.min(width - 4, 110));
  switch (overlay.kind) {
    case 'help':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={boxWidth}>
          <Text bold>Keyboard shortcuts</Text>
          {HELP_SECTIONS.map((section) => (
            <Box key={section.title} flexDirection="column" marginTop={1}>
              <Text color="cyan">{section.title}</Text>
              {section.keys.map(([k, d]) => (
                <Text key={k} wrap="truncate">{`  ${pad(k, 12)} ${d}`}</Text>
              ))}
            </Box>
          ))}
          <Text color="gray">esc / ? to close</Text>
        </Box>
      );
    case 'confirm':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={boxWidth}>
          <Text bold color="yellow">
            {overlay.title}
          </Text>
          <Text wrap="wrap">{overlay.message}</Text>
          <Text>
            <Text bold>y</Text> confirm · <Text bold>n</Text>/esc cancel
          </Text>
        </Box>
      );
    case 'input':
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={boxWidth}>
          <Text bold>{overlay.title}</Text>
          <Text>
            <Text color="cyan">{'> '}</Text>
            <Text>{overlay.value}</Text>
            <Text inverse> </Text>
          </Text>
          <Text color="gray">enter confirm · esc cancel · paste works</Text>
        </Box>
      );
    case 'switcher': {
      const { start, items } = windowed(projects, overlay.cursor, Math.max(3, height - 8));
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={boxWidth}>
          <Text bold>Switch project</Text>
          {projects.length === 0 ? <Text color="gray">No projects yet. Press + to register one.</Text> : null}
          {items.map((s, i) => (
            <Text key={s.project.id} inverse={start + i === overlay.cursor} wrap="truncate">
              {truncate(`${pad(s.project.name, 22)} ${shortPath(s.project.path)}`, boxWidth - 4)}
            </Text>
          ))}
          <Text color="gray">enter select · + register · esc close</Text>
        </Box>
      );
    }
    case 'picker': {
      const { start, items } = windowed(overlay.options, overlay.cursor, Math.max(3, height - 8));
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={boxWidth}>
          <Text bold wrap="wrap">{overlay.title}</Text>
          {items.map((o, i) => (
            <Text key={o.value} inverse={start + i === overlay.cursor} color={o.disabled ? 'gray' : undefined} wrap="truncate">
              {truncate(o.label, boxWidth - 4)}
            </Text>
          ))}
          <Text color="gray">enter choose · esc cancel</Text>
        </Box>
      );
    }
    case 'text': {
      const lines = overlay.body.split('\n');
      const visible = Math.max(3, height - 4);
      const slice = lines.slice(overlay.scroll, overlay.scroll + visible);
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={Math.max(30, width - 2)}>
          <Text bold wrap="truncate">{`${overlay.title}  (${Math.min(lines.length, overlay.scroll + 1)}-${Math.min(lines.length, overlay.scroll + visible)} of ${lines.length})`}</Text>
          {slice.map((l, i) => (
            <Text key={i} wrap="truncate" color={l.startsWith('+') && !l.startsWith('+++') ? 'green' : l.startsWith('-') && !l.startsWith('---') ? 'red' : l.startsWith('#') ? 'cyan' : undefined}>
              {truncate(l.replace(/\t/g, '  '), Math.max(10, width - 6)) || ' '}
            </Text>
          ))}
          <Text color="gray">↑↓ / j k scroll · space/b page · g/G top/bottom · esc close</Text>
        </Box>
      );
    }
  }
}
