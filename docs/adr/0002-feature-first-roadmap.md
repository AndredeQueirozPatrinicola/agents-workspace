# ADR 0002: Feature-first roadmap

- Status: accepted
- Date: 2026-10-28
- Supersedes: the roadmap order in [ADR 0001](0001-integrated-environment.md) §12 (the subsystem boundaries in ADR 0001 still hold)

## Context

ADR 0001 ordered the work bottom-up: persistence and domain model (M2), planning (M3), managed execution (M4), routing (M5). That is technically sound, but the user would only feel the value at M4.

The workflow `aw` has to beat is short: open Claude Code or Codex, describe a feature in semi-structured natural language with file references, let it run. Until `aw` is less work than that, nothing else matters. The user wants to:

1. Write one request, the way they already do.
2. Have an orchestrator read the project, decide whether splitting is worth it, and assign the work.
3. Approve once and go do something else.
4. Be interrupted only for decisions: blocked agents, conflicts, plan changes.
5. Review one integrated result, not five loose branches.
6. Get model, effort and account chosen with a stated reason they can override, instead of over-spending on simple tasks and under-spending on hard ones.
7. Switch between accounts (two Codex, one Claude) when credits run out, without losing the task.

## Decision

Ship a thin vertical slice of the whole flow first, on top of the infrastructure that already exists, then deepen each part.

| Milestone | Delivers |
|---|---|
| **M2: Feature end to end** | `n` in the dashboard (or `aw feature new`): request → planner → plan review → agents start in waves |
| **M3: Close the loop** | agents report `done`/`blocked` → `aw` runs the validation commands → integrates into the feature branch → one PR per feature |
| **M4: Accounts and routing** | named account profiles, user-initiated account switch with a handoff, model/effort recommendation with reasons, per-project account policy |
| **M5: Headless and polish** | managed (non-interactive) execution, token accounting, budgets, assistant persona |

M2–M4 are implemented together in 0.3.0. M5 stays open.

### 1. The orchestrator is an agent

There is no home-grown "brain". The planner is Claude Code or Codex running **read-only** in the main checkout, so it reads the real code, `AGENTS.md`, `CLAUDE.md` and the files the request mentions. Both CLIs enforce a JSON schema on the answer:

- `codex exec --sandbox read-only --output-schema <file> -o <file> -`
- `claude -p --permission-mode plan --output-format json --json-schema <schema>` (the answer is in `structured_output`)

The plan lists tasks with objective, context, scope globs, dependencies, acceptance criteria, validation commands, and a complexity/risk rating with a reason. `aw` validates it (unknown dependencies, cycles, overlapping scopes, bad ids) before showing it.

The planner prompt states the most important rule: **parallelize only when it pays**. A cohesive feature should be one task on a strong model with high effort. Fake parallelism creates conflicts and rework.

### 2. Agents stay interactive in tmux

The scheduler uses the existing `spawn`. Tasks without pending dependencies start first; the next wave starts when its dependencies are integrated. The user can still attach to any agent (`t`) and talk to it. No headless engine is needed for M2–M4.

### 3. Done and blocked are a file contract

The prompt of a feature task asks the agent to commit its work and then write `status.json` in its outbox (the shared files area, outside the repository):

```json
{ "status": "done", "summary": "…" }
{ "status": "blocked", "summary": "…", "questions": ["…"] }
```

A conductor process (a small tmux session per project, `aw feature watch`) polls it:

- `blocked` raises an attention item; the user answers (`aw feature answer`, or `a` in the dashboard) and the answer is typed into the agent.
- `done` runs the task's validation commands in its worktree. `aw` does not trust the claim alone. A failure is sent back to the agent; after two failed attempts the task needs the user.
- An agent that exits without a status, or whose terminal shows a usage-limit message, raises an attention item.

The status file is renamed after it is consumed, so each report is handled once.

### 4. One branch per feature

```
main
 └─ feature/jwt-auth              ← feature branch (the PR comes from here)
     ├─ feature/jwt-auth--schema   task 1
     ├─ feature/jwt-auth--api      task 2 (parallel)
     └─ feature/jwt-auth--admin    task 3 (starts after 1 and 2 are integrated)
```

(`feature/x` and `feature/x/y` cannot coexist as Git refs, hence `--`.)

- A validated task is merged into the feature branch with `git merge --no-ff` in a dedicated integration worktree. This is local and never touches the base branch.
- Dependent tasks branch from the updated feature branch, so "my dependency isn't merged yet" disappears.
- On a conflict the integration merge is aborted (it only contains the merge `aw` just started), the feature branch is merged into the task branch inside the task's worktree (`aw sync`, never a rebase), and the agent is asked to resolve and report `done` again.
- When every task is integrated, the feature is `ready`; `aw feature pr` publishes it through the existing PR flow (secret scan, confirmation, draft by default). Agent Workspace still never merges pull requests.

Policy: `features.integrate: auto | confirm` in `workspace.yaml` (default `auto`). With `confirm`, validated tasks wait for the user.

### 5. Feature agents live in runtime state, not in workspace.yaml

Feature tasks are agents like any other (same worktree, tmux, PR, cleanup machinery), but they are defined in the feature's runtime record (`<git-common-dir>/agent-workspace/features/<id>/feature.json`) and merged into the configuration in memory. The committed `workspace.yaml` and `.agents/tasks/` are not touched, and the user's working tree stays clean. Plans and event logs are JSON files; SQLite is postponed until a real need (cross-project history, queries) appears.

### 6. Routing is the user's policy, not magic

- Machine-local settings in the data directory (`settings.yaml`) declare accounts and routing rules:

  ```yaml
  accounts:
    codex-personal: { provider: codex, home: ~/.codex-personal, tags: [personal] }
    codex-work:     { provider: codex, home: ~/.codex,          tags: [work] }
    claude-work:    { provider: claude, home: ~/.claude,        tags: [work] }
  routing:
    planner: { account: claude-work, effort: high }
    rules:
      - when: { complexity: low }
        use: { account: codex-personal, effort: low }
      - when: { risk: high }
        use: { account: claude-work, effort: high }
  ```

- Without settings, sensible defaults apply: the provider's default login, and effort low/medium/high from the task's complexity.
- A project restricts accounts in `workspace.yaml` (`accounts: [work]`, tags or names). The router never chooses a disallowed account, and the user cannot pick one in the review either.
- Every routing decision carries its reason ("rule 2: risk high → claude-work, effort high"). The plan review shows it and lets the user change account and effort per task with one key.
- Outcomes (attempts, first-pass validation) are recorded per task, so a later version can show "medium effort passed first time in 80% of tasks like this" and suggest rule changes from data.

### 7. Accounts and switching

An account is an isolated configuration directory selected with `CODEX_HOME` (Codex) or `CLAUDE_CONFIG_DIR` (Claude Code). Login is the CLI's own (`aw accounts login <name>` runs it with the right directory). Agent Workspace never reads, copies or stores credentials.

Conversations cannot move between accounts: their history lives inside each account's directory. Switching is therefore a **handoff**:

1. The agent hits a limit (detected in its terminal, or marked by the user) and the dashboard shows it.
2. The user chooses another allowed account (`c` in the dashboard, or `aw switch <agent> <account>`). Accounts are never rotated automatically.
3. `aw` relaunches the agent in the same worktree and tmux session with the new account and a handoff prompt: the task, commits so far, diff stat, uncommitted files, the last status report and the tail of the previous terminal.

Because the work is in Git, not in the conversation, this is close to switching accounts in the desktop apps.

## Kept invariants

- One mandatory human checkpoint: approving the plan. After that the user is interrupted only for blocked agents, conflicts that fail twice, validation failures that fail twice, account limits, or work outside the approved scope.
- No sandbox-bypass flags to ease automation; agents keep each CLI's normal permission prompts, answered in tmux.
- The manual mode stays: `+` in the dashboard and `aw spawn` work as before.
- No force operations, no automatic PR merges, no credential handling.

## Consequences

- The value arrives in the first release of the new roadmap.
- The conductor is a polling process; it is cheap (a few git/tmux calls every few seconds) and survives closing the dashboard because it runs in tmux.
- Planner quality bounds feature quality. The plan review and the "one task is fine" rule are the mitigation.
- JSON files limit cross-project analytics; acceptable until M5.
