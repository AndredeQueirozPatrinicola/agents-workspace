# Example: parallel development of a SaaS application

This walkthrough builds a small multi-tenant SaaS (organizations, users, roles, projects, an admin UI) with five agents working at the same time: **database**, **backend**, **auth**, **rbac** and **admin**. The configuration and task files are in [`examples/saas/.agents/`](../examples/saas/.agents/) and are validated by the test suite.

## 1. Plan the work around shared contracts

Agents are fast, but they cannot coordinate with each other by themselves. The way to get real parallelism is to decide the *interfaces* first and let each agent build one side of them.

Before spawning anything, commit a `docs/contracts/` directory to `main` (a human job, roughly 30–60 minutes, or one agent run you review carefully):

| Contract | Consumed by |
|----------|-------------|
| `entities.md` — tables, fields, relations | database, backend, auth |
| `repositories.ts` — repository interfaces (`UserRepository`, `ProjectRepository`, …) | database (implements), backend, auth (consume) |
| `identity.ts` — `{ userId, organizationId }` on authenticated requests | auth (produces), rbac, backend |
| `permissions.md` — role × permission matrix | rbac, admin |
| `openapi.yaml` — endpoint shapes | backend (implements), admin (consumes via mock server) |

Also decide **ownership of hot files** that everyone wants to touch. In this example `backend` owns `src/app.ts` (route registration) and `package.json` changes are proposed in PR descriptions rather than made by every agent.

## 2. Dependency graph

```
                ┌──────────► backend ─────────┐
  contracts ──► database                      ├──► admin (data views)
  (main)        └──────────► auth ──► rbac ───┘
```

| Agent | Can start | Depends on (merge order) | Works against before the dependency merges |
|-------|-----------|--------------------------|--------------------------------------------|
| database | now | — | — |
| backend | now | database | repository interfaces + in-memory fakes |
| auth | now | database | `users` contract + in-memory `UserRepository` |
| rbac | once auth's identity contract is on main (it is, from step 1) | auth | identity stub |
| admin | UI shell now | backend, rbac | mock API generated from `openapi.yaml` |

`dependsOn` in `workspace.yaml` records the right-hand column. It does not stop you from spawning an agent; it is shown in `aw status`, injected into the agent's prompt ("database is NOT yet merged: code against the contract"), and reported by `aw check` until the dependency's PR is merged.

What **cannot** be parallel:

- Contract changes. If `database` needs to rename a field, every consumer is affected — stop, update `docs/contracts/` on `main`, and tell the other agents.
- Final integration of `admin` data views needs real endpoints and role rules.
- Anything touching the same hot file (`src/app.ts`, lockfiles, shared config) — assign one owner.

## 3. Set it up

```sh
cd ~/projects/my-saas
aw init
cp -r ~/src/agent-workspace/examples/saas/.agents/. .agents/   # or write your own
git add .agents docs/contracts && git commit -m "Agent Workspace config and shared contracts"
aw doctor
aw status
```

`aw status` now lists five configured agents, all `· not spawned`, with their task titles and dependencies.

## 4. Wave 1: start four agents in parallel

```sh
aw spawn database
aw spawn backend
aw spawn auth
aw spawn admin --prompt "For now build only the layout, navigation and sign-in screen against the mock API."
aw dashboard
```

Each agent gets its own worktree (`../.agent-workspace/my-saas/<agent>`), branch (`feat/<agent>`) and tmux session. The dashboard shows a 2×2 grid; click a pane to talk to that agent, `Ctrl-a n` for the status window, `Ctrl-a d` to detach (agents keep running).

While they work:

```sh
aw status          # ahead/behind, uncommitted changes, session state per agent
aw check           # overlaps / conflicts so far (read-only)
```

Typical `aw check` findings and what to do:

- *"backend changed 1 file(s) outside its declared scope: src/db/client.ts"* → ask backend why; probably it should use the repository interface instead.
- *"backend and auth both modified 1 file(s) (merges cleanly today): package.json"* → expected for dependencies; review both PRs together.
- *"backend and auth have conflicting changes: src/app.ts"* → auth was supposed to export a plugin, not edit `src/app.ts`. Tell auth to revert that change.

## 5. Integrate database first

```sh
aw pr database          # pushes feat/database after confirmation, opens a draft PR
aw pr status            # checks and review state for all agents
```

Review and merge the PR on GitHub. Then refresh the cached PR state and update the dependants:

```sh
git checkout main && git pull
aw pr status            # database now shows "merged"; dependants see it as satisfied
aw check --fetch        # backend and auth are now "behind main"
```

Ask backend and auth (in their panes) to merge `main` into their branch and switch from in-memory fakes to the real repositories, then re-run their validation commands. `aw` never rebases or merges for you.

## 6. Wave 2: rbac

```sh
aw pr auth              # after auth finishes; merge it
aw spawn rbac
```

rbac's prompt states that `auth` is merged and lists the other agents and their scopes, so it builds on `request.identity` and stays inside `src/rbac/**` and the `authorize` hook.

## 7. Finish admin and clean up

When backend and rbac are merged, continue admin in the same conversation:

```sh
aw attach admin          # "backend and rbac are merged; replace the mock API with the real one"
aw pr admin
```

After each PR is merged:

```sh
aw cleanup database --delete-branch   # removes the clean worktree; deletes the branch only if merged
aw cleanup backend --delete-branch
```

`cleanup` refuses if a worktree still has uncommitted files, and `--delete-branch` keeps any branch that is not fully merged.

## 8. Continue on another machine

Everything that matters is in Git: `.agents/` (config + tasks), `docs/contracts/` and the pushed agent branches.

```sh
git clone git@github.com:you/my-saas.git && cd my-saas
aw doctor
aw spawn admin            # worktree from origin/feat/admin; fresh conversation with the task prompt
```

## Summary of the parallelism

| Time → | | | |
|---|---|---|---|
| contracts (human) | database ▶ PR | | |
| | backend (fakes) ───────▶ merge main ▶ PR | | |
| | auth (fakes) ──────────▶ merge main ▶ PR | rbac ▶ PR | |
| | admin shell (mock API) ─────────────────────────────── | | admin data views ▶ PR |

Four agents work simultaneously from the start; only rbac and the final admin integration wait, and they wait on *merged contracts*, not on each other's half-finished code.
