# ADR 0001: Evolving Agent Workspace into an integrated multi-agent environment

- **Status:** accepted. Milestone 1 is implemented; Milestones 2–5 are proposed.
- **Date:** 2026-10-28
- **Scope:** product direction, subsystem boundaries, domain model, persistence, TUI technology, managed execution, account profiles, routing and the delivery roadmap.

## 1. Context

Agent Workspace (`aw`) is a working CLI. Today it does five things:

- creates one Git worktree and branch per agent;
- launches Codex or Claude Code in a dedicated tmux session;
- keeps versioned config in `.agents/` and machine state in `.git/agent-workspace/`;
- checks parallel-development risks (`aw check`);
- publishes work through `gh` (`aw pr`).

Every step still needs the user's judgement: which agents to create, how to split a feature, which provider, model and effort to use, and when to look at progress. The product should invert that. The user describes an intention, and the tool investigates the repository, proposes a plan, executes it safely in parallel and presents validated results. The human stays the architect, product owner and reviewer.

This ADR records the audit of the existing code, the target architecture, and the order in which it will be built.

## 2. Audit of the existing codebase

| Module | What it does | Verdict |
|---|---|---|
| `infrastructure/process` (`NodeCommandRunner`, `shellQuote`) | argv-only process execution, typed errors | **Keep.** Foundation for managed execution (needs a streaming variant). |
| `infrastructure/filesystem` (`writeFileAtomic`, `FileLock`) | atomic writes; link-based locks verified by a multi-process stress test | **Keep.** Reused for the global registry. |
| `infrastructure/terminal` (`TerminalBackend`, `TmuxBackend`) | exact-match tmux targets, respawn in place, `sendText`, dashboard | **Keep and extend** (session activity for the TUI). The TUI controls tmux only through this adapter. |
| `core/git` (`Git`) | safe git wrapper: merge-tree, push range, ignored files, merge | **Keep.** Feature-level views compose it. |
| `core/worktrees` (`WorktreeManager`) | create, adopt or remove worktrees safely; ownership markers | **Keep.** Task-scoped branches reuse it unchanged. |
| `core/agents` (`AgentService`) | lifecycle: spawn, restart, stop, tell, sync, cleanup, status | **Keep** as the *Execution Engine's interactive path*. Split later (see §5). |
| `core/sessions` (launcher, `openDashboard`) | POSIX launcher, exit-status files, tmux dashboard | **Keep.** The tmux dashboard stays available as `aw dashboard`. |
| `core/state` (`StateStore`) | per-clone JSON in `.git/agent-workspace` | **Keep** as the per-repository runtime store. SQLite (M2) indexes it, it does not replace it. |
| `core/config` | `.agents/workspace.yaml` (zod, comment-preserving edits) | **Keep and extend** with versioned migrations when new fields arrive. |
| `core/tasks` (`buildAgentPrompt`, task files) | Markdown task briefs → prompt | **Keep.** Planner-generated tasks render to the same format, so humans can still edit them. |
| `core/github` (`GitHubClient`, `PrService`) | gh wrapper, guarded PR creation, PR cache | **Keep.** Feature-level PR views aggregate it. |
| `core/safety` | overlap, secret and conflict heuristics | **Keep.** Plan validation reuses glob checks. |
| `providers` (`CodexProvider`, `ClaudeProvider`) | interactive launch commands, `--help` probing | **Extend** with managed (non-interactive) commands, profile environments and effort mapping. |
| `cli` | commander adapters, `runCli` returns exit codes | **Keep.** `aw` without arguments opens the TUI when interactive. |

Strengths to preserve: data-safety guarantees (no force, no destructive git, marker-based ownership, refusal to lose ignored files or detached commits), argv-only process execution, exact tmux targeting, tests that use temporary repositories and a private tmux server, and the explicit exit codes.

Gaps the new direction must fill:

1. There is no notion of *project* beyond the current directory, and no global state.
2. The domain is agent-centric: a configured agent equals a branch equals a task. There is no Feature, Task or Run.
3. Execution is interactive only. There are no structured events, no outcome records, and no scheduling.
4. There are no account profiles. Providers use whatever login the user's home directory holds.
5. The UI is a CLI plus a tmux grid. Nothing ties projects, agents, PRs and approvals together.

## 3. Decision: five subsystems with explicit boundaries

```
┌───────────────────────────── A. Workspace UI ─────────────────────────────┐
│ Ink TUI (aw) · CLI commands (scripting) · tmux dashboard (aw dashboard)    │
└──────────────┬──────────────────────────────┬─────────────────────────────┘
               │ WorkspaceController          │ approvals / plan edits
┌──────────────▼──────────────┐   ┌───────────▼────────────────────────────┐
│ B. Orchestrator Engine (M3+)│   │ D. Model Router (M5)                    │
│ discovery → plan → schedule │──▶│ provider/profile/model/effort + "why"   │
│ → validate                  │   └────────────────────────────────────────┘
└──────────────┬──────────────┘
               │ ExecutionRequest (task, worktree, profile, mode)
┌──────────────▼─────────────────────────────────────────────────────────────┐
│ C. Execution Engine (exists)                                                │
│ WorktreeManager · AgentService (interactive/tmux) · ManagedRunner (M4)      │
│ providers (codex, claude) · Git · GitHub (gh)                               │
└──────────────┬─────────────────────────────────────────────────────────────┘
┌──────────────▼─────────────────────────────────────────────────────────────┐
│ E. Local Workspace Store                                                    │
│ M1: global project registry (JSON, data dir) + per-repo StateStore          │
│ M2: SQLite (projects, features, tasks, runs, events, routing, approvals)    │
└────────────────────────────────────────────────────────────────────────────┘
```

Dependency rule: UI → Orchestrator → Router / Execution → Store. Lower layers never import upper ones. Every boundary is a TypeScript interface collected in `core/deps.ts`, so tests can inject fakes.

## 4. Domain model (introduced in M2, designed now)

| Entity | Identity | Key fields | Lifecycle |
|---|---|---|---|
| Project | `prj_<hash of git common dir>` | name, path, commonDir, defaults, allowed profiles | registered → missing (path gone) → forgotten |
| Feature | `fea_<ulid>` | projectId, title, request (verbatim), mode, planId | draft → planning → awaiting_approval → approved → running → validating → done / failed / cancelled |
| ExecutionPlan | `pln_<ulid>` | featureId, version, assumptions, risks, tasks[], edges[], approvedAt/by | proposed → approved / rejected → superseded |
| Task | `tsk_<ulid>` | planId, objective, scope globs, acceptance, validation cmds, dependsOn[], integration strategy | pending → ready → running → succeeded / failed / blocked / cancelled |
| ExecutionRun | `run_<ulid>` | taskId, attempt, mode (interactive or managed), profileId, model, effort, worktree, branch, baseCommit | queued → starting → running → exited(code) → evaluated(pass/fail) |
| AgentSession | tmux session name or managed pid | runId, backend, startedAt, lastActivity | live → exited → closed |
| ProviderProfile | `pfl_<slug>` | provider, label, trust (personal or corporate), configDir, defaults | created → login_pending → ready → disabled |
| RoutingDecision | `rtd_<ulid>` | runId, inputs, chosen provider/profile/model/effort, explanation, overriddenBy | immutable |
| ApprovalRequest | `apr_<ulid>` | subject (plan, task, action), reason, policy, requestedAt, decision | pending → approved / denied / expired |
| ExecutionEvent | monotonically increasing id | runId, ts, type, payload (redacted) | append-only |
| Artifact | `art_<ulid>` | runId, kind (diff, test report, summary, outbox file), path or digest | immutable |
| PullRequestReference | `pr_<repo>#<n>` | taskIds, branch, base, state, checks, dependsOnPr | mirrors GitHub |

Principles:

- **A task is not an agent.** A run is one attempt at a task with one profile, model and effort. Retries, provider changes and handoffs are new runs.
- **Transitions are explicit.** Each entity has a transition table and a `transition(entity, to)` guard that rejects illegal moves; the guards get property tests.
- **Branches are task-scoped** (`aw/<feature-slug>/<task-slug>`), not tied to an agent forever.
- **Today's configured agents map onto the model.** A configured agent maps to a Task whose runs are interactive. Existing `.agents/workspace.yaml` files keep working unchanged.

## 5. Persistence

- **M1 (implemented):** a global *project registry* at `<data dir>/projects.json`, written atomically under a `FileLock` and versioned (`version: 1`). Behind the `ProjectRegistry` interface.
- **M2:** SQLite at `<data dir>/workspace.db`, with numbered migrations in a transaction, WAL mode and `busy_timeout` so concurrent `aw` processes stay consistent.
  - Engine choice: Node's built-in `node:sqlite` (no native build, synchronous) once the minimum Node version is raised to 22.13; `better-sqlite3` as the fallback if that proves unstable.
  - The JSON registry is imported idempotently on first open and kept read-only as a backup.
  - The per-repository `StateStore` stays the source of truth for worktrees and sessions in that clone; SQLite indexes it. Nothing is deleted automatically.
- **Data directory:** `$AW_DATA_DIR`, then `$XDG_DATA_HOME/agent-workspace`, then `~/.local/share/agent-workspace` on Linux/WSL, and `~/Library/Application Support/agent-workspace` on macOS.
- **Never stored:** tokens, cookies, provider credentials, environment variable values. Profiles store only a directory path and metadata.

## 6. Workspace UI: Ink + React

**Decision:** Ink 6.8 with React 19. Default command: `aw` (interactive TTY) and `aw ui`.

Alternatives considered:

- **blessed / neo-blessed:** richer widgets, but unmaintained and with poor TypeScript support.
- **terminal-kit:** imperative, and harder to test.
- **A Go or Rust TUI** (bubbletea, ratatui): excellent, but a second language and toolchain for a TypeScript project.
- **Ink 8** (released 2026-10-03): too new to adopt as a foundation. Upgrading later is a contained change.

Why Ink: same language and stack, a declarative component model, testable with `ink-testing-library`, and good enough performance for a dashboard refreshed every few seconds.

Design rules:

- **No embedded terminal emulator.** Attach suspends the TUI (unmount Ink), runs `tmux attach`, and restores the TUI with the same view state afterwards. Closing the TUI never touches agent sessions.
- **The TUI never shells out on its own.** It talks to a `WorkspaceController`, which composes the existing services (`AgentService`, `TmuxBackend`, `GitHubClient`). The same controller will later expose orchestration.
- **State and rendering are separate.** Navigation and focus live in a pure reducer (`tui/state.ts`) with unit tests; views are thin.
- **Layout:** sidebar (Overview, Projects, Features, Agents, Accounts, Activity, Settings) when width is at least 90 columns; a compact one-line tab bar below that.
- **Refresh:** live data is polled every 3 s with overlapping refreshes suppressed. GitHub data is fetched only on demand, because it is network-bound and needs auth.

## 7. Execution Engine: interactive and managed modes (M4)

- **Interactive mode** stays exactly as it is: tmux and the native TUIs, with no telemetry required.
- **Managed mode** adds a `ManagedRunner` that runs documented non-interactive contracts and parses machine-readable events:
  - Codex: `codex exec --json` (JSON Lines events), with `--output-last-message`, `--sandbox` and `--cd`. `--output-schema <file>` constrains the final message to a JSON Schema, which the planner uses. All of these were verified in codex-cli 0.165.0 `exec --help`.
  - Claude Code: `claude -p --output-format stream-json --verbose`, with `--permission-mode` and allowed tools.

  Implementation rules:

  - **Defensive parsers:** provider parsers normalise events into a common `ExecutionEvent` union. Unknown fields are kept, unknown event types become `provider.raw`, and parsing never throws.
  - **Raw output:** kept per run, redacted, size-capped and rotated.
  - **Supervisor:** a detached local supervisor (single instance via a lock file, IPC over a Unix socket in the data directory, crash recovery from the store) is introduced *only if* managed runs must outlive the TUI. Until then, managed runs execute inside tmux sessions. That already gives detachment without a daemon.
- **Never** pass sandbox-bypass flags (`--dangerously-*`, `danger-full-access`, `bypassPermissions`) by default. Autonomous mode requires an explicit policy.

## 8. Account profiles (M2)

- A profile is a named, isolated configuration directory: `<data dir>/profiles/<slug>/`. It is used through each CLI's **documented** override:
  - Codex reads `CODEX_HOME`.
  - Claude Code reads `CLAUDE_CONFIG_DIR`.

  Each profile is launched by setting that one variable in the agent's environment. Login runs the native command (`codex login`, `claude` → `/login`) with the variable set. `aw` never opens files inside the directory.
- Authentication checks only use provider-documented status commands. If none exists, the state is "unknown"; `aw` never infers it by reading token files.
- Trust policies: `personal` or `corporate` per profile; projects declare `allowedProfiles`. The router can never select a profile the policy forbids, even when the allowed one is rate-limited. Crossing a trust boundary creates an ApprovalRequest.
- Switching the profile of an active task creates a **new run** seeded with a handoff summary (commits, diff stat, task, last agent summary). The original session is preserved. `aw` never claims that conversations migrate between profiles.

## 9. Model Router (M5)

- Capabilities are configured or discovered per provider (models, supported effort values). Nothing is assumed universal.
  - Claude Code 2.1.312 has `--effort <low|medium|high|xhigh|max>` (verified in `--help`).
  - Codex exposes reasoning effort through its configuration (`-c model_reasoning_effort=...`); the accepted values must be verified per version before they are offered.
  - Effort values are provider-specific strings, never a shared enum.
- Heuristic inputs: scope size, number of touched areas, security- or auth-sensitive paths, dependency fan-in/out, risk flags from the plan, user preferences and allowlists, profile policy, recorded outcomes.
- The output always includes a human-readable explanation. Overrides are recorded.
- Unsupported effort values fail clearly or fall back to a documented default with user approval.
- Usage tracking records only what providers expose (token counts in structured output, wall time, retries). Unknown quota is shown as "unknown". Accounts are never rotated to dodge limits.

## 10. Orchestration (M3–M4)

1. **Discovery:** a read-only run (sandbox `read-only` / plan mode) with a structured-output instruction. It inventories architecture, modules, tests, contracts and risks.
2. **Planning:** the planner returns JSON validated by zod. The plan is rejected if it has unknown dependencies, cycles, scopes outside the repository, forbidden operations, or overlapping write scopes without a declared integration strategy. Plans are saved before approval.
3. **Approval:** a concise TUI view covering tasks, parallel waves, dependencies, the proposed profile/model/effort with reasons, risks and the integration strategy. Plans are editable. Approval binds scope: any expansion needs a new approval.
4. **Scheduling:** topological waves with a concurrency limit. Integration strategies are `wait-for-merge` (default), `from-approved-commit`, or `stacked-branch`, and each is recorded per edge.
5. **Validation:** a task passes only when its validation commands succeed in its worktree *and* acceptance checks hold. Exit codes and agent claims are recorded but never sufficient on their own.

Modes: **Manual** (today), **Assisted** (primary: plan → approve → execute), **Autonomous** (explicit opt-in, bounded by an approved policy and budget).

## 11. Portability

- **Portable (in Git):** `.agents/workspace.yaml`, task files, contracts, `AGENTS.md`/`CLAUDE.md`, team-safe preferences.
- **Machine-local:** data directory (registry, SQLite, logs, profiles), absolute paths, tmux sessions, processes.

GitHub carries branches, commits and PRs. Handoff summaries are written as artifacts (and optionally committed under `.agents/handoff/`), so work can resume on another machine without the local chat history.

## 12. Roadmap

> **Superseded by [ADR 0002](0002-feature-first-roadmap.md).** The order below was replaced by a feature-first order: M2 feature end to end, M3 close the loop, M4 accounts and routing, M5 headless. The table is kept for history.

| Milestone | Deliverables | Status |
|---|---|---|
| **M1** Product foundation and TUI | ADR; data directory; global project registry with `aw projects`; live snapshot service; Ink TUI (sidebar, projects, agents, branches/PRs, attach/start/stop/restart, logs, diff, help, empty states); `aw` opens the TUI; all CLI commands unchanged | **Done** |
| **M2** Profiles and task domain | SQLite store with migrations; registry import; Feature/Task/Run/Event entities with transition guards; provider profiles (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`), login, trust policies; Accounts view | Next |
| **M3** Planning | discovery runner (read-only); planner schema and validation; plan approval/editing UI; plan persistence | Proposed |
| **M4** Managed execution | `ManagedRunner` with Codex/Claude stream parsers; scheduler with concurrency and integration strategies; cancellation, timeouts, retries; validation results | Proposed |
| **M5** Routing and handoff | router with explanations; usage capture; profile switching via handoff; feature-level GitHub view (stacked PRs, CI, conflicts) | Proposed |

## 13. Consequences

- New runtime dependencies in M1: `ink` and `react`, which add roughly 2 MB to `node_modules`. No service and no daemon.
- `aw` with no arguments changes behaviour. Interactive terminals get the TUI. Non-interactive use still prints help, so scripts are unaffected.
- The domain model and SQLite arrive in M2. Until then the TUI reads the same per-repository state the CLI writes, so both stay consistent by construction.
