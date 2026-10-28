# Architecture

> For where this architecture is heading (orchestration, SQLite store, managed execution, account profiles, model routing), see [ADR 0001](adr/0001-integrated-environment.md). Milestone 1 added `core/projects` (global registry), `core/workspace/snapshot.ts` and `controller.ts` (the frontend boundary), and `src/tui` (the Ink dashboard).

This document explains how Agent Workspace is put together, why, and where the risks are.

## Goals and constraints

In priority order: correctness and data safety, simplicity, portability (Linux, macOS, WSL2), developer experience, maintainability, extensibility.

Constraints that shaped the design:

- **No daemon, no database, no network service.** Every `aw` invocation is a short-lived process that reads state, acts, and exits. Long-lived things (agent processes) are owned by tmux.
- **Orchestrate, don't replace.** Git, tmux, gh and the agent CLIs do the real work. `aw` composes them and adds safety checks.
- **Never destroy work.** No force flags, no resets, no history rewriting; removal only of clean, aw-owned worktrees, after confirmation.

## Layers

```
cli/            commander program, rendering, exit codes          (adapters)
core/           agent lifecycle, config, worktrees, PRs, safety   (application logic)
providers/      Codex, Claude Code                                (pluggable)
infrastructure/ processes, filesystem, tmux, terminal UI          (side effects)
```

- `cli/` never contains business rules; each action calls a core service and renders the result.
- `core/` depends on interfaces (`CommandRunner`, `TerminalBackend`, `Prompter`, `Ui`, `AgentProvider`) collected in `core/deps.ts`. Tests swap them for mocks or capture objects.
- `providers/` only describe launch commands (pure functions plus detection). They do not run anything.
- `infrastructure/process/runner.ts` is the single place where child processes are spawned — always with argument arrays and `shell: false`.

## Key components

| Module | Responsibility |
|--------|----------------|
| `core/workspace/workspace.ts` | Resolve repository → config root → workspace directory → state store; tmux session naming. |
| `core/config/` | Zod schema with semantic checks (unknown providers, dependency cycles, reserved names), YAML parsing with readable errors, comment-preserving edits (`yaml` Document API). |
| `core/git/git.ts` | Typed wrapper over the git CLI. Exposes only safe operations: `worktree remove` without `--force`, `branch -d`, `push` without `--force`, `merge-tree` for in-memory merges. |
| `core/worktrees/manager.ts` | Create/reuse/adopt worktrees; ownership markers; safe removal. |
| `core/state/runtime-state.ts` | Machine-local JSON state with atomic writes and a lock around read-modify-write. |
| `core/sessions/launcher.ts` | Generate the per-agent POSIX launcher script; derive session state (running / exited / stopped). |
| `core/sessions/dashboard.ts` | Build the dashboard session from running agents. |
| `core/agents/service.ts` | The lifecycle: add, spawn, stop, attach, status, cleanup. |
| `core/github/` | `gh` wrapper (pure argument builders + client) and the PR workflow. |
| `core/safety/` | Glob overlap, secret heuristics, the `aw check` report. |
| `providers/` | `AgentProvider` interface, `CliProvider` base (detection, `--help` probing), Codex, Claude, registry. |
| `infrastructure/terminal/tmux.ts` | `TerminalBackend` implementation for tmux. |

## Configuration vs runtime state

| | Versioned configuration | Runtime state |
|---|---|---|
| Location | `.agents/workspace.yaml`, `.agents/tasks/*.md` | `<git-common-dir>/agent-workspace/` |
| Shared via | Git (commit, push) | never shared |
| Contents | project, defaults, providers, agents, scopes, dependencies, task briefs | absolute worktree paths, tmux session names, launch scripts, prompts, exit codes, PR cache, locks |
| Lifetime | the project | disposable; rebuilt by `aw repair` |

Storing runtime state in the **Git common directory** has useful properties: one state per clone, shared by every worktree of that clone, automatically outside the working tree (so it can never be committed), and deleted with the clone.

State files:

```
.git/agent-workspace/
├── state.json                 { version, configRoot, agents: { <name>: AgentRecord } }
├── state.lock                 held only during read-modify-write
└── agents/<name>/
    ├── launch.sh              generated launcher (0700)
    ├── prompt.md              initial prompt (0600)
    ├── exit-status            exit code of the last agent run
    └── agent.lock             held while an aw command manages this agent
```

`AgentRecord`: name, provider, branch, base, worktreePath, createdAt/updatedAt, session `{ backend, name, startedAt }`, lastLaunch `{ at, command (prompt redacted), resumed }`, pr `{ number, url, state, isDraft, updatedAt }`.

### Configuration root resolution

`aw` can be run from the main worktree, any subdirectory, or inside an agent worktree:

1. the current worktree, if it has `.agents/workspace.yaml` and is not an aw-managed agent worktree;
2. otherwise the repository's main worktree;
3. otherwise the config root recorded in state (bare repository + worktrees layouts).

This keeps one source of truth even though every agent worktree also contains a (possibly older) copy of `.agents/`.

## Agent lifecycle

```
            ┌───────────── aw add ─────────────┐
            ▼                                  │
     configured ──aw spawn──► running ──agent exits──► exited
            ▲                  │   ▲                     │
            │              aw stop │ aw spawn            │ aw stop
            │                  ▼   │                     ▼
            │               stopped ◄────────────────────┘
            │                  │
            └── aw cleanup ◄───┘   (worktree removed; branch kept)
```

`spawn` in detail:

1. Validate the name; open the workspace; add the agent to the config if needed (comment-preserving YAML edit + task file).
2. Resolve the agent (config + CLI overrides); check tmux and the provider executable.
3. Acquire `agents/<name>/agent.lock` (fail fast if another `aw` holds it; reclaim if its owner is dead).
4. If the tmux session exists → report and stop (idempotent).
5. `WorktreeManager.ensure`: reuse → adopt (interrupted spawn) → create from local branch → from remote branch → new branch from base.
6. Record the agent in state **before** starting the session, so an interruption leaves a recoverable record.
7. Advisory checks: behind base, dependency states.
8. Load the task, build the prompt (unless template / `--no-prompt` / `--resume`), write `prompt.md` and `launch.sh`.
9. `tmux new-session -d -s <name> -c <worktree> /bin/sh <launch.sh>` (multi-argument → no shell parsing by tmux); tag the session with `@aw_*` options.
10. Record session and launch metadata.

The launcher runs the agent with `trap ':' INT` (so Ctrl-C reaches the agent but does not kill the wrapper), records the exit code, then `exec`s an interactive shell so the session (and the agent's last output) remains.

## Interrupted operations and recovery

Every step is designed so that a crash at any point leaves a state that `aw` can understand:

| Interrupted after | Leftover | Recovery |
|---|---|---|
| worktree created, before marker | unmarked worktree on the agent branch at the expected path | next `spawn` offers to adopt it (confirmation / `--yes`; branch must match) |
| marker written, before state | marked worktree, no record | next `spawn` reuses it; `aw repair` re-adopts |
| state written, before tmux | record without session | status shows `stopped`; `spawn` starts the session |
| tmux started, before session recorded | session without record | `spawn` sees the session and reports it; `repair` clears/reports |
| any time holding a lock | lock file with dead pid | reclaimed automatically; `aw repair` removes it |
| state.json half-written | impossible (atomic rename) | — |
| state.json corrupted otherwise | backup + empty state | `aw repair` re-adopts marked worktrees |
| worktree directory deleted by hand | Git metadata + record | `aw repair` forgets the record (under the agent lock, only if no session runs) and removes that worktree's admin dir after confirmation; unmarked user worktrees are only reported |

## Extension points

- **Providers:** implement `AgentProvider` (usually by extending `CliProvider`) and register it. Capabilities (`initialPrompt`, `modelSelection`, `resume`) and `requiredFlags` let the core and `aw doctor` adapt without provider-specific branches.
- **Terminal backends:** implement `TerminalBackend` (sessions, keys, pane state, attach, dashboard). The agent lifecycle only uses the interface. `workspace.terminal` is the config switch (only `tmux` is accepted today).
- **Scheduling / delegation:** `dependsOn`, per-agent scopes, PR state in runtime state and the `aw check` report are the inputs a future scheduler needs. Nothing schedules automatically yet, by design.
- **Session history / handoff:** runtime state already records launches; a future `aw handoff` could export them. Conversations remain owned by each provider CLI.
- **Graphical dashboard / remote execution:** `aw status --json`, `aw check --json`, `aw pr status --json` and `aw doctor --json` are stable machine-readable surfaces to build on.

## Technical risks and how they are handled

| Risk | Mitigation |
|---|---|
| Provider CLIs change flags | Only long-standing, documented flags are used; `aw doctor` probes `--help` for them; providers are isolated single files. |
| Prompts with quotes, `$()` or newlines | Prompt is a file read by `"$(cat …)"`; no interpolation into shell code; tests cover quoting. |
| Linux 128 KiB single-argument limit | Prompts over ~96 KiB reference the task file by path instead. |
| tmux target ambiguity (`=` prefix matching, pane vs session targets) | All targets use exact-match forms (`=name` for sessions, `=name:` for pane/option targets); covered by integration tests on a private tmux server. |
| Interfering with the user's tmux | Unique `aw-` names, session-scoped options only (no global keybindings), optional private server via `AW_TMUX_SOCKET`. |
| Concurrent `aw` commands | Per-agent fail-fast locks; state updates under a waiting lock; atomic writes. Locks are published via `link()` (never half-written), stale reclaim renames then re-verifies, release checks ownership; multi-process stress test. |
| Logical conflicts between branches | `aw check`: overlaps, out-of-scope changes, behind-base, simulated merges (`git merge-tree`), dependencies. |
| Leaking secrets through PRs | Sensitive-path and secret-pattern checks over every commit in the push range (`<branch> --not --remotes=<remote>`), with `core.quotePath=false` so non-ASCII paths are matched; explicit override required. |
| Losing work on cleanup | Refuse on uncommitted/untracked files, non-regenerable ignored files, and HEAD commits not contained in any ref; `git worktree remove` without `--force`. |
| Untrusted committed config | Warnings for custom provider executables and sandbox-disabling flags. |
| WSL2 performance on `/mnt/c` | `aw doctor` warns; docs recommend the Linux filesystem. |
| Git versions | `--path-format=absolute` needs 2.31 (checked by doctor); merge simulation degrades gracefully below 2.38. |
