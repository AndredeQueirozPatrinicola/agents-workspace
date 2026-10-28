import React from 'react';
import { Box, Text } from 'ink';
import type { ActivityEntry, ProviderInfo, SettingsInfo } from '../core/workspace/controller.js';
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

export function Sidebar({ view, focused, height }: { view: ViewId; focused: boolean; height: number }) {
  return (
    <Box flexDirection="column" width={16} height={height} borderStyle="single" borderColor={focused ? 'cyan' : 'gray'} paddingX={1}>
      {VIEWS.map((v, i) => (
        <Text key={v} color={v === view ? 'cyan' : undefined} bold={v === view} inverse={v === view && focused}>
          {`${i + 1} ${VIEW_LABELS[v]}`}
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
  const cols = { name: 14, provider: 8, state: 15, branch: Math.max(12, Math.min(28, width - 70)), ab: 9, changes: 14, pr: 10 };
  const header = `${pad('AGENT', cols.name)} ${pad('PROVIDER', cols.provider)} ${pad('STATE', cols.state)} ${pad('BRANCH', cols.branch)} ${pad('VS BASE', cols.ab)} ${pad('CHANGES', cols.changes)} ${pad('PR', cols.pr)} ACTIVITY`;
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
                `${pad(a.name, cols.name)} ${pad(a.provider, cols.provider)} ${pad(sessionText(a), cols.state)} ${pad(a.branch, cols.branch)} ${pad(aheadBehindText(a.ahead, a.behind), cols.ab)} ${pad(changesText(a.changes), cols.changes)} ${pad(prText(a.pr), cols.pr)} ${relativeTime(a.lastActivity)}`,
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
    ['Profile', `${agent.profile} (the CLI's own login; profiles arrive in M2)`],
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

export function OverviewView({ snapshot, cursor, width, height, projectCount }: Sized & { snapshot: ProjectSnapshot | null; cursor: number; projectCount: number }) {
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
  const attention = agents.filter((a) => a.session === 'exited' || (a.changes?.conflicted ?? 0) > 0 || (a.behind ?? 0) > 0 || (a.spawned && !a.worktreeExists));
  const c = snapshot.config;
  // Line budget: sections shrink (and the branch list disappears) on small terminals.
  let budget = height - 3 - snapshot.warnings.length;
  const attentionRows = Math.min(attention.length, height < 24 ? 2 : 5);
  budget -= 2 + Math.max(1, attentionRows);
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
      <Text bold>Needs attention</Text>
      {attention.length === 0 ? <Text color="gray">Nothing right now.</Text> : null}
      {attention.slice(0, attentionRows).map((a) => (
        <Text key={a.name} color="yellow" wrap="truncate">
          {truncate(
            `• ${a.name}: ${[
              a.session === 'exited' ? `agent exited${a.exitCode !== null ? ` (${a.exitCode})` : ''}, press r to restart` : null,
              (a.changes?.conflicted ?? 0) > 0 ? 'merge conflicts' : null,
              (a.behind ?? 0) > 0 ? `${a.behind} behind ${a.base}` : null,
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

export function FeaturesView({ snapshot }: { snapshot: ProjectSnapshot | null }) {
  const manual = snapshot?.agents.length ?? 0;
  return (
    <Empty
      title="Features"
      lines={[
        'Natural-language features (describe → plan → approve → parallel execution) arrive in Milestone 3.',
        manual
          ? `Today this project has ${manual} manually configured agent(s): each one is a manual task. See Agents (a).`
          : 'Today, create manual tasks with: aw spawn <name> --task "..."  (press o for a shell).',
        'Design: docs/adr/0001-integrated-environment.md',
      ]}
    />
  );
}

export function AccountsView({ providers, width }: { providers: ProviderInfo[] | null; width: number }) {
  return (
    <Box flexDirection="column">
      <Text bold>Accounts</Text>
      <Text color="gray" wrap="wrap">
        Every agent currently uses the provider CLI's own login in your home directory (profile "default"). Named, isolated profiles (CODEX_HOME / CLAUDE_CONFIG_DIR, personal vs corporate policies) arrive in Milestone 2.
      </Text>
      <Text> </Text>
      {providers === null ? <Text color="gray">Detecting provider CLIs…</Text> : null}
      {(providers ?? []).map((p) => (
        <Text key={p.id} wrap="truncate" color={p.installed ? undefined : 'yellow'}>
          {truncate(
            `${pad(p.name, 14)} ${pad(p.installed ? `installed ${p.version ?? ''}` : 'not installed', 22)} ${p.installed ? (p.missingFlags.length ? `missing flags: ${p.missingFlags.join(', ')}` : 'profile: default') : p.installHint}`,
            width,
          )}
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
