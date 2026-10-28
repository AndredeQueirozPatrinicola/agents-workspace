# Demo transcript

Real output of the built `aw` CLI driving three agents in one repository. It was recorded in a sandbox where
Codex and Claude Code could not authenticate, so `codex` and `claude` on `PATH` were small stand-in scripts that
accept the same arguments and stay running; everything else (Git worktrees, branches, tmux sessions, the
dashboard, safety checks, cleanup) is the real thing. The agents' commits were made by hand in their worktrees to
simulate work, including a deliberate conflict on `src/app.ts`. Colors are disabled (`NO_COLOR=1`).

With real CLIs installed and logged in, the same commands start the actual agents: in that sandbox, `aw spawn`
with the real Claude Code 2.1.312 and Codex 0.165.0 binaries launched both with the generated arguments (they then
stopped at their own sign-in screens).

```text
$ aw init
Agent Workspace

Project:   my-saas
Base:      main
Provider:  codex

✓ Created .agents/workspace.yaml
✓ Created .agents/README.md
✓ Created .agents/tasks/.gitkeep

Next steps:
  aw spawn <agent> --provider codex|claude --task "What this agent should do"
  git add .agents && git commit -m "Add Agent Workspace configuration"

$ aw add database -p claude -t "Model organizations, users, roles and projects with migrations" --scope "src/db/**,migrations/**"
✓ Added agent "database" to .agents/workspace.yaml
✓ Created .agents/tasks/database.md

Start it with: aw spawn database

$ aw add backend -p codex -t "CRUD API for users and projects" --scope "src/api/**,src/app.ts" --depends-on database
✓ Added agent "backend" to .agents/workspace.yaml
✓ Created .agents/tasks/backend.md

Start it with: aw spawn backend

$ aw add auth -p claude -t "JWT login with refresh-token rotation" --scope "src/auth/**" --depends-on database
✓ Added agent "auth" to .agents/workspace.yaml
✓ Created .agents/tasks/auth.md

Start it with: aw spawn auth

$ aw spawn database
Agent Workspace

Project:   my-saas
Agent:     database
Provider:  Claude Code
Branch:    agent/database

✓ Repository validated
✓ Configuration loaded
✓ Worktree created (new branch agent/database from main)
  ~/projects/.agent-workspace/my-saas/database
✓ Task loaded (.agents/tasks/database.md)
✓ tmux session created (aw-my-saas-03323f-database)

Agent started successfully.

Attach:
  aw attach database

Status:
  aw status

$ aw spawn backend && aw spawn auth   # output omitted

# (the agents commit some work in their worktrees)

$ aw status
Agent Workspace · my-saas (base: main)
Worktrees: ~/projects/.agent-workspace/my-saas

database  claude  ● running         agent/database            ↑1 ↓0      clean
  task  Model organizations, users, roles and projects with migrations  (.agents/tasks/database.md)
  path  ~/projects/.agent-workspace/my-saas/database

backend   codex   ● running         agent/backend             ↑1 ↓0      1 untracked
  task  CRUD API for users and projects  (.agents/tasks/backend.md)
  path  ~/projects/.agent-workspace/my-saas/backend
  deps  database (in progress)

auth      claude  ● running         agent/auth                ↑1 ↓0      clean
  task  JWT login with refresh-token rotation  (.agents/tasks/auth.md)
  path  ~/projects/.agent-workspace/my-saas/auth
  deps  database (in progress)

3 agent(s), 3 running.  aw attach <agent> · aw dashboard · aw check

$ aw check
Parallel development check

Branches checked: database, backend, auth

! auth changed 1 file(s) outside its declared scope.
    src/app.ts
✗ backend and auth have conflicting changes (will conflict when both are merged).
    src/app.ts
• backend depends on database, which is in progress.
• auth depends on database, which is in progress.

Nothing was changed. Resolve conflicts manually; Agent Workspace never merges or rebases for you.

$ aw dashboard --no-attach
✓ Dashboard ready with 3 agent(s): database, backend, auth

Open it with:
  tmux attach -t "=aw-my-saas-03323f--dashboard"

$ tmux -L awdemo2 list-windows -t =aw-my-saas-03323f--dashboard
agents: 3 pane(s)
status: 1 pane(s)

$ aw dashboard --kill
✓ Dashboard closed. Agents are still running.

$ aw stop auth --yes
✓ Stopped agent "auth" (tmux session closed).
• Worktree preserved: ~/projects/.agent-workspace/my-saas/auth

Restart:
  aw spawn auth            # new conversation
  aw spawn auth --resume   # continue the previous conversation

$ aw cleanup backend --yes
Error: Worktree for "backend" has uncommitted changes; refusing to clean up.
  src/api/draft.ts
Hint: Commit or stash the changes in ~/projects/.agent-workspace/my-saas/backend first. Agent Workspace never deletes uncommitted work.

$ aw cleanup database --yes
! agent/database has 1 commit(s) not in main and is not pushed. They stay on the local branch.
✓ tmux session stopped
✓ Worktree removed (~/projects/.agent-workspace/my-saas/database)
• Branch agent/database kept.
• "database" is still configured in .agents/workspace.yaml; "aw spawn database" recreates its worktree.

Cleaned up "database".

$ git worktree list
~/projects/my-saas                           f2efe73 [main]
~/projects/.agent-workspace/my-saas/auth     c659a1c [agent/auth]
~/projects/.agent-workspace/my-saas/backend  abb6252 [agent/backend]

$ git branch
+ agent/auth
+ agent/backend
  agent/database
* main

```
